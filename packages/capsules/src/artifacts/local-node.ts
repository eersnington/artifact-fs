import { CapsuleError } from "../core/errors.js";
import type { CommittedStep } from "../core/types.js";
import {
  CommitQueue,
  type RepoHandle,
  type TreeStore,
} from "./tree-backend.js";

/**
 * Local Node artifact store: run repos are plain Git working trees under a
 * root directory, committed with the native `git` binary. This is the layer
 * for Node scripts, tests, and CLIs.
 *
 * The root can be a normal directory or a directory you later serve/inspect
 * with ArtifactFS (`artifact-fs daemon`); Capsule does not manage the
 * ArtifactFS daemon lifecycle itself.
 *
 * Node-only: imports `node:` modules lazily so the package entry stays
 * runtime-neutral for Workers bundlers.
 */
export type LocalNodeOptions = {
  /** Directory that holds one Git repo per Workflow run. */
  readonly mountRoot: string;
  /** Commit author. Defaults to workflow-capsules. */
  readonly author?: { readonly name: string; readonly email: string };
};

const DEFAULT_AUTHOR = {
  name: "workflow-capsules",
  email: "capsules@workflow.invalid",
};

export function localNodeStore(options: LocalNodeOptions): TreeStore {
  const author = options.author ?? DEFAULT_AUTHOR;
  const handles = new Map<string, Promise<RepoHandle>>();

  return {
    kind: "local-node",

    openRepo(name, init) {
      let pending = handles.get(name);
      if (pending === undefined) {
        pending = open(name, init).catch((error) => {
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
    const [fs, path, { execFile }, { promisify }] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
      import("node:child_process"),
      import("node:util"),
    ]);
    const exec = promisify(execFile);
    const repoDir = path.join(options.mountRoot, name);

    const git = async (...args: string[]): Promise<string> => {
      try {
        const { stdout } = await exec(
          "git",
          [
            "-c",
            `user.name=${author.name}`,
            "-c",
            `user.email=${author.email}`,
            ...args,
          ],
          { cwd: repoDir },
        );
        return stdout.trim();
      } catch (error) {
        const stderr =
          error !== null && typeof error === "object" && "stderr" in error
            ? String((error as { stderr: unknown }).stderr).trim()
            : "";
        throw new CapsuleError(
          "BACKEND_WRITE_FAILED",
          `git ${args[0]} failed in ${repoDir}: ${stderr || String(error)}. ` +
            `Committed history is intact; fix the repository state and retry the step.`,
          { cause: error },
        );
      }
    };

    const writeFiles = async (files: ReadonlyMap<string, Uint8Array>): Promise<void> => {
      for (const [repoPath, bytes] of files) {
        const target = path.join(repoDir, repoPath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, bytes);
      }
    };

    const headSha = async (): Promise<string | undefined> => {
      try {
        const { stdout } = await exec("git", ["rev-parse", "HEAD"], {
          cwd: repoDir,
        });
        return stdout.trim();
      } catch {
        return undefined;
      }
    };

    await fs.mkdir(repoDir, { recursive: true });
    const isRepo = await fs
      .stat(path.join(repoDir, ".git"))
      .then(() => true)
      .catch(() => false);
    if (!isRepo) {
      await git("init", "-b", init.branch);
    }
    if ((await headSha()) === undefined) {
      await writeFiles(init.initFiles);
      await git("add", "-A");
      await git("commit", "-m", init.initMessage);
    }

    const queue = new CommitQueue();
    return {
      repo: name,
      branch: init.branch,
      head: headSha,

      async readFile(repoPath: string): Promise<Uint8Array | null> {
        try {
          const data = await fs.readFile(path.join(repoDir, repoPath));
          return new Uint8Array(data);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw new CapsuleError(
            "BACKEND_WRITE_FAILED",
            `Could not read ${repoPath} from local capsule repo ${repoDir}: ${String(cause)}. ` +
              `Committed history is intact; check local filesystem permissions and retry.`,
            { cause },
          );
        }
      },

      commit(input): Promise<CommittedStep> {
        return queue.run(async () => {
          const parent = await headSha();
          await writeFiles(input.files);
          await git("add", "-A", "--", ...input.files.keys());
          await git("commit", "-m", input.message);
          const commit = await git("rev-parse", "HEAD");
          return {
            commit,
            ...(parent !== undefined ? { parent } : {}),
          };
        });
      },

      async findCommitFor(repoPath: string): Promise<CommittedStep | undefined> {
        try {
          const logOutput = await git(
            "log",
            "-n",
            "1",
            "--format=%H %P",
            "--",
            repoPath,
          );
          if (logOutput === "") return undefined;
          const [commit, parent] = logOutput.split(/\s+/);
          if (commit === undefined) return undefined;
          return {
            commit,
            ...(parent !== undefined && parent !== "" ? { parent } : {}),
          };
        } catch {
          return undefined;
        }
      },
    };
  }
}
