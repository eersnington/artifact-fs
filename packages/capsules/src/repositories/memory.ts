import type { CommittedRecord } from "../core/types.js";
import { digestFileContent, sha256Hex } from "../core/content-digest.js";
import {
  SerialCommitQueue,
  type RepositorySession,
  type RepositoryStore,
} from "./backend.js";

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
  readonly commitQueue: SerialCommitQueue;
};

export type MemoryStore = RepositoryStore & {
  /** Test/debug access to raw repos. */
  repos(): ReadonlyMap<string, ReadonlyArray<MemoryCommit>>;
};

export function memoryRepositoryStore(): MemoryStore {
  const repositories = new Map<string, MemoryRepo>();

  return {
    kind: "memory",

    repos() {
      return new Map([...repositories].map(([name, repo]) => [name, repo.commits]));
    },

    async openRepository(name, init) {
      let repo = repositories.get(name);
      if (repo === undefined) {
        repo = {
          name,
          branch: init.branch,
          commits: [],
          commitQueue: new SerialCommitQueue(),
        };
        repositories.set(name, repo);
        await commitMemoryFiles(repo, init.initFiles, init.initMessage);
      }
      return createMemoryRepositorySession(repo);
    },
  };
}

function createMemoryRepositorySession(repo: MemoryRepo): RepositorySession {
  return {
    repo: repo.name,
    branch: repo.branch,

    async readHead() {
      return repo.commits.at(-1)?.sha;
    },

    async readFile(path) {
      const head = repo.commits.at(-1);
      return head?.tree.get(path) ?? null;
    },

    commitFiles(input) {
      return repo.commitQueue.run(() =>
        commitMemoryFiles(repo, input.files, input.message),
      );
    },
  };
}

async function commitMemoryFiles(
  repo: MemoryRepo,
  files: ReadonlyMap<string, Uint8Array>,
  message: string,
): Promise<CommittedRecord> {
  const parent = repo.commits.at(-1);
  const tree = new Map(parent?.tree ?? []);
  for (const [path, bytes] of files) {
    tree.set(path, bytes);
  }
  const digests: Array<[string, string]> = [];
  for (const [path, bytes] of [...files].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    digests.push([path, await digestFileContent(bytes)]);
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
