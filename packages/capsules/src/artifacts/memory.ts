import type { CommittedStep } from "../core/types.js";
import { sha256Hex, digestBytes } from "../internal/hash.js";
import {
  CommitQueue,
  type RepoHandle,
  type TreeStore,
} from "./tree-backend.js";

/**
 * In-memory artifact store for tests, examples, and deterministic unit runs.
 * Models the same semantics as the Git-backed stores: immutable commits,
 * parent links, and per-path introduction tracking for precise resolveStep.
 */

type MemoryCommit = {
  readonly sha: string;
  readonly parent?: string;
  readonly message: string;
  readonly tree: ReadonlyMap<string, Uint8Array>;
  readonly changedPaths: ReadonlySet<string>;
};

type MemoryRepo = {
  readonly name: string;
  readonly branch: string;
  readonly commits: MemoryCommit[];
  readonly queue: CommitQueue;
};

export type MemoryStore = TreeStore & {
  /** Test/debug access to raw repos. */
  repos(): ReadonlyMap<string, ReadonlyArray<MemoryCommit>>;
};

export function memoryStore(): MemoryStore {
  const repos = new Map<string, MemoryRepo>();

  return {
    kind: "memory",

    repos() {
      return new Map([...repos].map(([name, repo]) => [name, repo.commits]));
    },

    async openRepo(name, init) {
      let repo = repos.get(name);
      if (repo === undefined) {
        repo = {
          name,
          branch: init.branch,
          commits: [],
          queue: new CommitQueue(),
        };
        repos.set(name, repo);
        await commitTo(repo, init.initFiles, init.initMessage);
      }
      return handleFor(repo);
    },
  };
}

function handleFor(repo: MemoryRepo): RepoHandle {
  return {
    repo: repo.name,
    branch: repo.branch,

    async head() {
      return repo.commits.at(-1)?.sha;
    },

    async readFile(path) {
      const head = repo.commits.at(-1);
      return head?.tree.get(path) ?? null;
    },

    commit(input) {
      return repo.queue.run(() =>
        commitTo(repo, input.files, input.message),
      );
    },

    async findCommitFor(path) {
      for (let i = repo.commits.length - 1; i >= 0; i--) {
        const commit = repo.commits[i]!;
        if (commit.changedPaths.has(path)) {
          return {
            commit: commit.sha,
            ...(commit.parent !== undefined ? { parent: commit.parent } : {}),
          };
        }
      }
      return undefined;
    },
  };
}

async function commitTo(
  repo: MemoryRepo,
  files: ReadonlyMap<string, Uint8Array>,
  message: string,
): Promise<CommittedStep> {
  const parent = repo.commits.at(-1);
  const tree = new Map(parent?.tree ?? []);
  for (const [path, bytes] of files) {
    tree.set(path, bytes);
  }
  const digests: Array<[string, string]> = [];
  for (const [path, bytes] of [...files].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    digests.push([path, await digestBytes(bytes)]);
  }
  const sha = (
    await sha256Hex(
      new TextEncoder().encode(
        JSON.stringify({ parent: parent?.sha ?? null, message, digests }),
      ),
    )
  ).slice(0, 40);
  repo.commits.push({
    sha,
    ...(parent !== undefined ? { parent: parent.sha } : {}),
    message,
    tree,
    changedPaths: new Set(files.keys()),
  });
  return {
    commit: sha,
    ...(parent !== undefined ? { parent: parent.sha } : {}),
  };
}
