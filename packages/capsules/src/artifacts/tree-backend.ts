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

type TreeRunSession = ArtifactRunSession & { readonly handle: RepoHandle };
type TreeStepSession = ArtifactStepSession & {
  readonly staged: Map<string, Uint8Array>;
};

export function createTreeBackend(store: TreeStore): ArtifactBackend {
  return {
    kind: store.kind,

    async openRun(input: OpenRunInput): Promise<ArtifactRunSession> {
      const handle = await store.openRepo(input.repoName, {
        branch: input.branch,
        initFiles: input.initFiles,
        initMessage: input.initMessage,
      });
      const session: TreeRunSession = {
        handle,
        repo: handle.repo,
        branch: handle.branch,
        readFile: (path) => handle.readFile(path),
        head: () => handle.head(),
      };
      return session;
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
      const staged = new Map<string, Uint8Array>();
      const session: TreeStepSession = {
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
