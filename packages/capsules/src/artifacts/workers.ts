import { CapsuleError, invalidRequest } from "../core/errors.js";
import type { CommittedStep } from "../core/types.js";
import { MemoryFS } from "../git/memory-fs.js";
import {
  CommitQueue,
  type RepoHandle,
  type TreeStore,
} from "./tree-backend.js";

/**
 * Structural types for the Cloudflare Artifacts Workers binding
 * (`env.ARTIFACTS`). Structural so this package never imports generated
 * Worker types; any object with this surface works, including test fakes.
 */
export type ArtifactsBindingLike = {
  create(
    name: string,
    opts?: {
      readonly description?: string;
      readonly readOnly?: boolean;
      readonly setDefaultBranch?: string;
    },
  ): Promise<ArtifactsCreatedRepoLike>;
  get(name: string): Promise<ArtifactsRepoHandleLike>;
};

export type ArtifactsCreatedRepoLike = {
  readonly name: string;
  readonly remote: string;
  readonly defaultBranch?: string;
  /** Initial write token; format `art_v1_<secret>?expires=<unix_seconds>`. */
  readonly token: string;
};

export type ArtifactsRepoHandleLike = {
  readonly name?: string;
  readonly remote?: string;
  createToken(
    scope?: "read" | "write",
    ttl?: number,
  ): Promise<{ readonly plaintext: string }>;
};

export type WorkersStoreOptions = {
  /**
   * Resolve the git remote URL for an existing repo when the binding handle
   * does not expose one. Required only if `get()` results lack `remote`.
   */
  readonly remoteFor?: (repoName: string) => string;
  /** Write-token TTL in seconds. Defaults to 900. */
  readonly tokenTtlSeconds?: number;
  /** Commit author. Defaults to workflow-capsules. */
  readonly author?: { readonly name: string; readonly email: string };
  /** @internal Test seam; defaults to the isomorphic-git engine. */
  readonly gitOps?: GitOps;
};

/**
 * Git engine seam. The Artifacts binding manages repos and tokens; this Git
 * writer handles file trees, commits, and pushes because the binding does not
 * expose direct file-write or commit methods. Contract tests inject a fake so
 * they run without the network.
 */
export type GitOps = {
  open(input: {
    readonly remote: string;
    readonly branch: string;
    readonly isNew: boolean;
    readonly auth: { readonly username: string; readonly password: string };
    readonly author: { readonly name: string; readonly email: string };
  }): Promise<GitWorkspace>;
};

export type GitWorkspace = {
  head(): Promise<string | undefined>;
  readFile(path: string): Promise<Uint8Array | null>;
  commitAndPush(
    files: ReadonlyMap<string, Uint8Array>,
    message: string,
  ): Promise<CommittedStep>;
};

const DEFAULT_AUTHOR = {
  name: "workflow-capsules",
  email: "capsules@workflow.invalid",
};

export function workersStore(
  binding: ArtifactsBindingLike,
  options?: WorkersStoreOptions,
): TreeStore {
  const handles = new Map<string, Promise<RepoHandle>>();
  const gitOps = options?.gitOps ?? isomorphicGitOps();
  const author = options?.author ?? DEFAULT_AUTHOR;
  const ttl = options?.tokenTtlSeconds ?? 900;

  return {
    kind: "workers-binding",

    openRepo(name, init) {
      let pending = handles.get(name);
      if (pending === undefined) {
        pending = open(name, init).catch((error) => {
          // Do not cache failures; the next call should retry.
          handles.delete(name);
          throw error;
        });
        handles.set(name, pending);
      }
      return pending;
    },
  };

  async function open(
    name: string,
    init: {
      readonly branch: string;
      readonly initFiles: ReadonlyMap<string, Uint8Array>;
      readonly initMessage: string;
    },
  ): Promise<RepoHandle> {
    const opened = await openOrCreateRepo(name, init.branch);
    const workspace = await gitOps.open({
      remote: opened.remote,
      branch: init.branch,
      isNew: opened.isNew,
      auth: { username: "x", password: opened.tokenSecret },
      author,
    });

    // A repo can exist with no commits (created, then the init push failed).
    if ((await workspace.head()) === undefined) {
      await workspace.commitAndPush(
        new Map(init.initFiles),
        init.initMessage,
      );
    }

    const queue = new CommitQueue();
    return {
      repo: name,
      branch: init.branch,
      head: () => workspace.head(),
      readFile: (path) => workspace.readFile(path),
      commit: (input) =>
        queue.run(() => workspace.commitAndPush(input.files, input.message)),
    };
  }

  async function openOrCreateRepo(
    name: string,
    branch: string,
  ): Promise<{ remote: string; tokenSecret: string; isNew: boolean }> {
    let getError: unknown;
    try {
      const handle = await binding.get(name);
      const remote = handle.remote ?? options?.remoteFor?.(name);
      if (remote === undefined) {
        throw invalidRequest(
          `Artifacts repo "${name}" exists but the binding handle did not expose a remote URL. ` +
            `Pass cloudflare(binding, { remoteFor: (repo) => url }) so Capsule can push to it.`,
        );
      }
      const token = await handle.createToken("write", ttl);
      return { remote, tokenSecret: tokenSecret(token.plaintext), isNew: false };
    } catch (error) {
      if (error instanceof CapsuleError) throw error;
      getError = error;
    }

    try {
      const created = await binding.create(name, { setDefaultBranch: branch });
      return {
        remote: created.remote,
        tokenSecret: tokenSecret(created.token),
        isNew: true,
      };
    } catch (createError) {
      throw new CapsuleError(
        "BACKEND_UNAVAILABLE",
        `Could not open Artifacts repo "${name}": get() failed (${describe(getError)}) ` +
          `and create() failed (${describe(createError)}). No commit was made. ` +
          `Check the Artifacts binding configuration and namespace permissions, then retry.`,
        { cause: createError },
      );
    }
  }
}

/** Artifacts tokens carry expiry metadata: `art_v1_<secret>?expires=<unix>`. */
function tokenSecret(token: string): string {
  return token.split("?expires=")[0] ?? token;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isomorphicGitOps(): GitOps {
  return {
    async open(input) {
      const [{ default: git }, { default: http }] = await Promise.all([
        import("isomorphic-git"),
        import("isomorphic-git/http/web"),
      ]);
      const fs = new MemoryFS();
      const dir = "/workspace";
      const onAuth = () => ({
        username: input.auth.username,
        password: input.auth.password,
      });

      if (input.isNew) {
        await git.init({ fs, dir, defaultBranch: input.branch });
      } else {
        try {
          await git.clone({
            fs,
            http,
            dir,
            url: input.remote,
            ref: input.branch,
            singleBranch: true,
            onAuth,
          });
        } catch (error) {
          throw new CapsuleError(
            "BACKEND_UNAVAILABLE",
            `Cloning Artifacts repo from its remote failed: ${describe(error)}. ` +
              `No commit was made. The repo may still be initializing; retry the step.`,
            { cause: error },
          );
        }
      }

      const head = async (): Promise<string | undefined> => {
        try {
          return await git.resolveRef({ fs, dir, ref: "HEAD" });
        } catch {
          return undefined;
        }
      };

      return {
        head,

        async readFile(path: string): Promise<Uint8Array | null> {
          try {
            const data = await fs.promises.readFile(`${dir}/${path}`);
            return typeof data === "string"
              ? new TextEncoder().encode(data)
              : data;
          } catch {
            return null;
          }
        },

        async commitAndPush(
          files: ReadonlyMap<string, Uint8Array>,
          message: string,
        ): Promise<CommittedStep> {
          const parent = await head();
          try {
            for (const [path, bytes] of files) {
              await fs.promises.writeFile(`${dir}/${path}`, bytes);
              await git.add({ fs, dir, filepath: path });
            }
            const commit = await git.commit({
              fs,
              dir,
              message,
              author: input.author,
            });
            await git.push({
              fs,
              http,
              dir,
              url: input.remote,
              ref: input.branch,
              onAuth,
            });
            return {
              commit,
              ...(parent !== undefined ? { parent } : {}),
            };
          } catch (error) {
            throw new CapsuleError(
              "BACKEND_WRITE_FAILED",
              `Committing/pushing capsule files to the Artifacts remote failed: ${describe(error)}. ` +
                `Previously pushed commits are intact. This is usually transient (token expiry or a ` +
                `concurrent push); the step can be retried safely.`,
              { cause: error },
            );
          }
        },
      };
    },
  };
}
