import type {
  ArtifactBackend,
  ArtifactRunSession,
  ArtifactWriteSession,
  CommittedRecord,
  OpenRunInput,
} from "../core/types.js";

/**
 * Minimal storage contract that memory, Cloudflare, local, and remote adapters
 * implement. The core layer decides record layout; repositories only read and
 * commit file batches.
 */
export interface RepositoryStore {
  readonly kind: string;
  openRepository(
    name: string,
    init: {
      readonly branch: string;
      readonly initFiles: ReadonlyMap<string, Uint8Array>;
      readonly initMessage: string;
    },
  ): Promise<RepositorySession>;
}

export interface RepositorySession {
  readonly repo: string;
  readonly branch: string;
  readHead(): Promise<string | undefined>;
  readFile(path: string): Promise<Uint8Array | null>;
  /** Implementations must serialize concurrent commits to the same repo. */
  commitFiles(input: {
    readonly files: ReadonlyMap<string, Uint8Array>;
    readonly message: string;
  }): Promise<CommittedRecord>;
}

type BackendRunSession = ArtifactRunSession & { readonly repository: RepositorySession };
type StagedWriteSession = ArtifactWriteSession & {
  readonly staged: Map<string, Uint8Array>;
};

export function createRepositoryBackend(store: RepositoryStore): ArtifactBackend {
  return {
    kind: store.kind,

    async openRun(input: OpenRunInput): Promise<ArtifactRunSession> {
      const repository = await store.openRepository(input.repoName, {
        branch: input.branch,
        initFiles: input.initFiles,
        initMessage: input.initMessage,
      });
      const session: BackendRunSession = {
        repository,
        repo: repository.repo,
        branch: repository.branch,
        readFile: (path) => repository.readFile(path),
        head: () => repository.readHead(),
      };
      return session;
    },

    async beginWrite(): Promise<ArtifactWriteSession> {
      const staged = new Map<string, Uint8Array>();
      return {
        staged,
        stage(path, bytes) {
          staged.set(path, bytes);
        },
      } as StagedWriteSession;
    },

    async commitWrite(
      session: ArtifactRunSession,
      write: ArtifactWriteSession,
      input: { readonly message: string },
    ): Promise<CommittedRecord> {
      const repository = (session as BackendRunSession).repository;
      return repository.commitFiles({
        files: (write as StagedWriteSession).staged,
        message: input.message,
      });
    },
  };
}

/** Serializes commit operations for a single repository. */
export class SerialCommitQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation, operation);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
