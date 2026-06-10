import type {
  ArtifactBackend,
  ArtifactRunSession,
  ArtifactStepSession,
  CommittedStep,
  OpenRunInput,
  ResolvedStep,
  StepIdentity,
  StepManifest,
} from "../core/types.js";
import { RUN_INDEX_PATH, manifestPath } from "../git/layout.js";

/**
 * Minimal storage contract that memory, Cloudflare, local, and remote
 * adapters implement. The adapter below turns any RepositoryStore into the canonical
 * ArtifactBackend, so commit layout and resolution logic exist exactly once.
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
  /**
   * Write the given repo-absolute paths on top of the current head tree and
   * commit. Implementations must serialize concurrent commits to the same
   * repo (Workflows allows concurrent step.do() calls via Promise.all).
   */
  commitFiles(input: {
    readonly files: ReadonlyMap<string, Uint8Array>;
    readonly message: string;
  }): Promise<CommittedStep>;
  /**
   * Find the commit that introduced the given path, when the store can do so
   * cheaply. Optional; the adapter falls back to the current head, which is
   * still an immutable SHA whose tree contains the path.
   */
  findCommitForPath?(path: string): Promise<CommittedStep | undefined>;
}

const decoder = new TextDecoder();

type BackendRunSession = ArtifactRunSession & { readonly repository: RepositorySession };
type StagedStepSession = ArtifactStepSession & {
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

    async resolveStep(
      session: ArtifactRunSession,
      step: StepIdentity,
    ): Promise<ResolvedStep | null> {
      const path = await resolveCommittedManifestPath(session, step);
      if (path === undefined) return null;
      const bytes = await session.readFile(path);
      if (bytes === null) return null;
      const manifest = JSON.parse(decoder.decode(bytes)) as StepManifest;
      const repository = (session as BackendRunSession).repository;
      const located = await repository.findCommitForPath?.(path);
      if (located !== undefined) {
        return { manifest, ...located };
      }
      const head = await session.head();
      if (head === undefined) return null;
      return { manifest, commit: head };
    },

    async beginStep(
      _session: ArtifactRunSession,
      step: StepIdentity,
    ): Promise<ArtifactStepSession> {
      const staged = new Map<string, Uint8Array>();
      const session: StagedStepSession = {
        identity: step,
        staged,
        stage(path, bytes) {
          staged.set(path, bytes);
        },
        hasStagedFiles() {
          for (const path of staged.keys()) {
            if (path.includes("/files/") || path.includes("/effects/")) return true;
          }
          return false;
        },
      };
      return session;
    },

    async commitStep(
      session: ArtifactRunSession,
      step: ArtifactStepSession,
      input: { message: string },
    ): Promise<CommittedStep> {
      const repository = (session as BackendRunSession).repository;
      return repository.commitFiles({
        files: (step as StagedStepSession).staged,
        message: input.message,
      });
    },
  };
}

async function resolveCommittedManifestPath(
  session: ArtifactRunSession,
  step: StepIdentity,
): Promise<string | undefined> {
  const indexBytes = await session.readFile(RUN_INDEX_PATH);
  if (indexBytes !== null) {
    const index = JSON.parse(decoder.decode(indexBytes)) as {
      entries?: Array<{
        stepDir: string;
        capsule: string;
        status: string;
        manifestPath: string;
      }>;
    };
    const entry = index.entries?.find(
      (candidate) =>
        candidate.status === "committed" &&
        candidate.stepDir === step.stepDir &&
        candidate.capsule === step.capsuleName,
    );
    if (entry !== undefined) return entry.manifestPath;
  }

  const currentAttemptPath = manifestPath(step.attemptDir);
  return (await session.readFile(currentAttemptPath)) !== null
    ? currentAttemptPath
    : undefined;
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
