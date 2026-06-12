import type { CallStore, CallStoreRun, CommitResult } from "../core/types.js";

type MemoryRepo = {
  readonly branch: string;
  readonly files: Map<string, Uint8Array>;
  commitNumber: number;
  queue: Promise<unknown>;
};

export function memoryCallStore(): CallStore {
  const repos = new Map<string, MemoryRepo>();

  return {
    kind: "memory",

    async openRun(input): Promise<CallStoreRun> {
      let repo = repos.get(input.repoName);
      if (repo === undefined) {
        repo = {
          branch: input.branch,
          files: new Map(input.initFiles),
          commitNumber: 1,
          queue: Promise.resolve(),
        };
        repos.set(input.repoName, repo);
      }

      return {
        repo: input.repoName,
        branch: repo.branch,
        async readHead() {
          return sha(repo!.commitNumber);
        },
        async readFile(path) {
          return repo!.files.get(path) ?? null;
        },
        commitFiles(commit) {
          const next = repo!.queue.then(async (): Promise<CommitResult> => {
            const parent = sha(repo!.commitNumber);
            for (const [path, bytes] of commit.files) {
              repo!.files.set(path, bytes);
            }
            repo!.commitNumber += 1;
            return { commit: sha(repo!.commitNumber), parent };
          });
          repo!.queue = next.catch(() => undefined);
          return next;
        },
      };
    },
  };
}

function sha(commitNumber: number): string {
  return String(commitNumber).padStart(40, "0");
}
