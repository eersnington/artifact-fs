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
import { manifestPath } from "../git/layout.js";

/**
 * Minimal storage contract that memory, Workers binding, and local-node
 * layers implement. The adapter below turns any TreeStore into the canonical
 * ArtifactBackend, so commit layout and resolution logic exist exactly once.
 */
export interface TreeStore {
  readonly kind: string;
  openRepo(
    name: string,
    init: {
      readonly branch: string;
      readonly initFiles: ReadonlyMap<string, Uint8Array>;
      readonly initMessage: string;
    },
  ): Promise<RepoHandle>;
}

export interface RepoHandle {
  readonly repo: string;
  readonly branch: string;
  head(): Promise<string | undefined>;
  readFile(path: string): Promise<Uint8Array | null>;
  /**
   * Write the given repo-absolute paths on top of the current head tree and
   * commit. Implementations must serialize concurrent commits to the same
   * repo (Workflows allows concurrent step.do() calls via Promise.all).
   */
  commit(input: {
    readonly files: ReadonlyMap<string, Uint8Array>;
    readonly message: string;
  }): Promise<CommittedStep>;
  /**
   * Find the commit that introduced the given path, when the store can do so
   * cheaply. Optional; the adapter falls back to the current head, which is
   * still an immutable SHA whose tree contains the path.
   */
  findCommitFor?(path: string): Promise<CommittedStep | undefined>;
}

const decoder = new TextDecoder();

class TreeRunSession implements ArtifactRunSession {
  constructor(readonly handle: RepoHandle) {}

  get repo(): string {
    return this.handle.repo;
  }

  get branch(): string {
    return this.handle.branch;
  }

  readFile(path: string): Promise<Uint8Array | null> {
    return this.handle.readFile(path);
  }

  head(): Promise<string | undefined> {
    return this.handle.head();
  }
}

class TreeStepSession implements ArtifactStepSession {
  readonly staged = new Map<string, Uint8Array>();

  constructor(readonly identity: StepIdentity) {}

  stage(path: string, bytes: Uint8Array): void {
    this.staged.set(path, bytes);
  }

  hasStagedFiles(): boolean {
    // The run index and manifests are bookkeeping; "did the producer write
    // anything" means files/ or effects/ content.
    for (const path of this.staged.keys()) {
      if (path.includes("/files/") || path.includes("/effects/")) return true;
    }
    return false;
  }
}

export function createTreeBackend(store: TreeStore): ArtifactBackend {
  return {
    kind: store.kind,

    async openRun(input: OpenRunInput): Promise<ArtifactRunSession> {
      const handle = await store.openRepo(input.repoName, {
        branch: input.branch,
        initFiles: input.initFiles,
        initMessage: input.initMessage,
      });
      return new TreeRunSession(handle);
    },

    async resolveStep(
      session: ArtifactRunSession,
      step: StepIdentity,
    ): Promise<ResolvedStep | null> {
      const path = manifestPath(step.attemptDir);
      const bytes = await session.readFile(path);
      if (bytes === null) return null;
      const manifest = JSON.parse(decoder.decode(bytes)) as StepManifest;
      const handle = (session as TreeRunSession).handle;
      const located = await handle.findCommitFor?.(path);
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
      return new TreeStepSession(step);
    },

    async commitStep(
      session: ArtifactRunSession,
      step: ArtifactStepSession,
      input: { message: string },
    ): Promise<CommittedStep> {
      const handle = (session as TreeRunSession).handle;
      return handle.commit({
        files: (step as TreeStepSession).staged,
        message: input.message,
      });
    },
  };
}

/** Serialize async operations; used by stores to order concurrent commits. */
export class CommitQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation, operation);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
