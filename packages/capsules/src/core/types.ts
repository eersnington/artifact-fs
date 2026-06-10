/**
 * Core public and internal types for workflow-capsules.
 *
 * Workflow types are structural ("-Like") so this package never imports
 * `cloudflare:workers` at runtime and works with any object that carries the
 * same metadata (including tests and non-Cloudflare runners).
 */

/** Branded identifier types. Constructed through `validation.ts` only. */
export type CapsuleId = string & { readonly __brand: "CapsuleId" };
export type CapsuleName = string & { readonly __brand: "CapsuleName" };
export type CapsulePath = string & { readonly __brand: "CapsulePath" };

/** Structural subset of Cloudflare's `WorkflowEvent<T>`. */
export type WorkflowEventLike = {
  readonly instanceId: string;
  readonly workflowName: string;
  readonly payload?: unknown;
  readonly timestamp?: Date;
};

/** Structural subset of Cloudflare's `WorkflowStepContext`. */
export type WorkflowStepContextLike = {
  readonly step: {
    readonly name: string;
    readonly count: number;
  };
  readonly attempt: number;
};

/** Minimal Standard Schema v1 surface used for optional input validation. */
export interface StandardSchemaV1<In = unknown, Out = In> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) =>
      | StandardSchemaResult<Out>
      | Promise<StandardSchemaResult<Out>>;
  };
  readonly "~types"?: { readonly input: In; readonly output: Out } | undefined;
}

export type StandardSchemaResult<Out> =
  | { readonly value: Out; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<{ readonly message: string }> };

/** Bodies accepted by `files.write()`. */
export type CapsuleFileBody =
  | string
  | Uint8Array
  | ArrayBuffer
  | Blob
  | ReadableStream<Uint8Array>
  | CapsuleJsonValue;

export type CapsuleJsonValue =
  | null
  | boolean
  | number
  | { readonly [key: string]: unknown }
  | ReadonlyArray<unknown>;

export type CapsuleFileOptions = {
  /** Explicit media type. Inferred from the file extension when omitted. */
  readonly mediaType?: string;
};

export type CapsuleFileRef = {
  /** Repo-absolute path, e.g. `steps/001-x/attempts/1/files/output/answer.md`. */
  readonly path: string;
  readonly mediaType?: string;
  readonly size?: number;
  readonly digest?: string;
};

export type CapsuleFiles = {
  /**
   * Write an artifact file into durable Git history for this step attempt.
   * Capsule stores exactly the bytes passed here; callers are responsible for
   * shaping, omitting, or transforming sensitive data before writing.
   */
  write(
    path: string,
    body: CapsuleFileBody,
    options?: CapsuleFileOptions,
  ): Promise<CapsuleFileRef>;
};

/**
 * Request or response snapshot for an external side effect that already
 * happened. Capsule stores exactly the body passed here in durable Git history;
 * callers decide what is safe to persist.
 */
export type CapsuleEffectSnapshotOptions = {
  readonly body: CapsuleFileBody;
  readonly mediaType?: string;
  /** Relative path inside this effect directory. Defaults to request/response.json. */
  readonly path?: string;
};

export type CapsuleEffectSnapshot = CapsuleFileBody | CapsuleEffectSnapshotOptions;

export type CapsuleEffectRecordInput = {
  readonly externalId?: string;
  readonly httpStatus?: number;
  readonly request?: CapsuleEffectSnapshot;
  readonly response?: CapsuleEffectSnapshot;
  readonly metadata?: Record<string, unknown>;
};

export type CapsuleEffectRef = {
  readonly kind: string;
  readonly path: string;
  readonly seq: number;
  readonly externalId?: string;
  readonly httpStatus?: number;
  readonly idempotencyKey?: string;
  readonly request?: CapsuleFileRef;
  readonly response?: CapsuleFileRef;
};

export type CapsuleEffects = {
  /**
   * Record an external side effect that already happened. This does not call
   * the provider. Optional request/response snapshots are persisted exactly as
   * supplied; callers decide what is safe to store in durable Git history.
   */
  record(kind: string, record?: CapsuleEffectRecordInput): Promise<CapsuleEffectRef>;
};

export type CapsuleRunContext<Input> = {
  readonly input: Input;
  readonly files: CapsuleFiles;
  readonly effects: CapsuleEffects;
  readonly idempotencyKey?: string;
};

export type CapsuleDedupe = {
  readonly key: string;
  /**
   * `record-reuse` records the dedupe key in the manifest so external tooling
   * can correlate identical content across runs. `reuse-output` (skipping the
   * producer) is reserved for a future cross-run content index.
   */
  readonly mode: "record-reuse" | "reuse-output";
};

export type CapsuleDefinition<Input, Output> = {
  readonly name: string;
  readonly input?: StandardSchemaV1<unknown, Input>;
  run(ctx: CapsuleRunContext<Input>): Promise<Output>;
};

export type CapsuleSpec<Input, Output> = {
  readonly workflow: WorkflowEventLike;
  readonly step: WorkflowStepContextLike;
  readonly name: string;
  readonly id?: string;
  readonly idempotencyKey?: string;
  readonly dedupe?: CapsuleDedupe;
  readonly input: Input;
  /** Optional Standard Schema used to validate `input` before `run`. */
  readonly inputSchema?: StandardSchemaV1<unknown, Input>;
  run(ctx: CapsuleRunContext<Input>): Promise<Output>;
};

export type DefinedCapsule<Input, Output> = {
  readonly name: string;
  with(
    args: Omit<CapsuleSpec<Input, Output>, "name" | "run" | "inputSchema">,
  ): CapsuleSpec<Input, Output>;
};

export type CapsuleRefs<Output = unknown> = {
  readonly capsule: {
    readonly name: string;
    readonly id: string;
    readonly inputHash: string;
    readonly idempotencyKey?: string;
    readonly dedupeKey?: string;
    readonly reusedFrom?: string;
  };
  readonly workflow: {
    readonly name: string;
    readonly instanceId: string;
    readonly stepName: string;
    readonly stepCount: number;
    readonly attempt: number;
  };
  readonly artifact: {
    readonly backend: string;
    readonly repo: string;
    readonly branch: string;
    readonly commit: string;
    readonly parent?: string;
  };
  /**
   * Map of files written by the capsule, keyed by the capsule-relative path
   * passed to `files.write()`. This is a plain record; it is not derived from
   * `Output`.
  */
  readonly files: Record<string, CapsuleFileRef>;
  readonly effects: ReadonlyArray<CapsuleEffectRef>;
  readonly output: Output;
  readonly manifestPath: string;
  readonly diff?: {
    readonly base: string;
    readonly head: string;
    readonly summaryPath?: string;
  };
};

export type CapsuleFailure = {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
};

/** JSON manifest written at `steps/<step>/attempts/<n>/manifest.json`. */
export type StepManifest = {
  readonly schemaVersion: 1;
  readonly workflow: { readonly name: string; readonly instanceId: string };
  readonly step: {
    readonly name: string;
    readonly count: number;
    readonly attempt: number;
  };
  readonly capsule: {
    readonly name: string;
    readonly id: string;
    readonly idempotencyKey?: string;
    readonly dedupeKey?: string;
  };
  readonly input: { readonly hash: string };
  readonly artifact: {
    readonly repo: string;
    readonly branch: string;
    /**
     * Parent commit at manifest-write time. The commit SHA that contains this
     * manifest cannot be known before committing; consumers should take the
     * head SHA from `CapsuleRefs.artifact.commit` or `git log`.
     */
    readonly parent?: string;
  };
  readonly files: Record<string, CapsuleFileRef>;
  readonly effects: ReadonlyArray<EffectRecord>;
  readonly output?: unknown;
  readonly startedAt: string;
  readonly finishedAt: string;
};

/** JSON audit record written at `steps/<step>/attempts/<n>/effects/<safe-kind>/record.json`. */
export type EffectRecord = {
  readonly kind: string;
  readonly path: string;
  readonly seq: number;
  readonly recordedAt: string;
  readonly workflow: { readonly name: string; readonly instanceId: string };
  readonly step: {
    readonly name: string;
    readonly count: number;
    readonly attempt: number;
  };
  readonly capsule: { readonly name: string; readonly id: string };
  readonly idempotencyKey?: string;
  readonly externalId?: string;
  readonly httpStatus?: number;
  readonly request?: CapsuleFileRef;
  readonly response?: CapsuleFileRef;
  readonly metadata?: Record<string, unknown>;
};

/** JSON failure record written at `steps/<step>/attempts/<n>/failure.json`. */
export type FailureManifest = {
  readonly schemaVersion: 1;
  readonly error: {
    readonly name: string;
    readonly message: string;
    readonly retryable: boolean;
  };
  readonly workflow: { readonly name: string; readonly instanceId: string };
  readonly step: {
    readonly name: string;
    readonly count: number;
    readonly attempt: number;
  };
  readonly capsule: {
    readonly name: string;
    readonly id: string;
    readonly idempotencyKey?: string;
  };
  readonly input: { readonly hash: string };
  readonly files: Record<string, CapsuleFileRef>;
  readonly effects: ReadonlyArray<EffectRecord>;
  /** True when an effect was recorded, so an external effect may have succeeded. */
  readonly externalEffectPossible: boolean;
  readonly failedAt: string;
};

/** Entry in `.capsule/index.json`, one per recorded step attempt. */
export type RunIndexEntry = {
  readonly stepDir: string;
  readonly attempt: number;
  readonly capsule: string;
  readonly inputHash: string;
  readonly status: "committed" | "failed";
  readonly manifestPath: string;
};

export type RunIndex = {
  readonly schemaVersion: 1;
  readonly entries: RunIndexEntry[];
};

// ---------------------------------------------------------------------------
// Internal artifact backend contract (one canonical contract for all layers).
// ---------------------------------------------------------------------------

export type StepIdentity = {
  readonly capsuleName: string;
  readonly capsuleId: string;
  readonly stepName: string;
  readonly stepCount: number;
  readonly attempt: number;
  readonly inputHash: string;
  readonly idempotencyKey?: string;
  /** `steps/<padded-count>-<slug>` directory for this step. */
  readonly stepDir: string;
  /** `steps/<stepDir>/attempts/<attempt>` base path. */
  readonly attemptDir: string;
};

export type OpenRunInput = {
  readonly workflowName: string;
  readonly instanceId: string;
  readonly repoName: string;
  readonly branch: string;
  /** Repo-absolute path -> bytes written by the init commit when the repo is new. */
  readonly initFiles: ReadonlyMap<string, Uint8Array>;
  readonly initMessage: string;
};

export type ArtifactRunSession = {
  readonly repo: string;
  readonly branch: string;
  /** Read a file from the current head tree. Returns null when absent. */
  readFile(path: string): Promise<Uint8Array | null>;
  head(): Promise<string | undefined>;
};

export type ArtifactStepSession = {
  readonly identity: StepIdentity;
  /** Stage bytes at a repo-absolute path for the next commit. */
  stage(path: string, bytes: Uint8Array): void;
  hasStagedFiles(): boolean;
};

export type ResolvedStep = {
  readonly manifest: StepManifest;
  /** A commit SHA whose tree contains the attempt (the introducing commit when cheap to determine, otherwise head). */
  readonly commit: string;
  readonly parent?: string;
};

export type CommittedStep = {
  readonly commit: string;
  readonly parent?: string;
};

export type ArtifactBackend = {
  readonly kind: string;
  openRun(input: OpenRunInput): Promise<ArtifactRunSession>;
  resolveStep(
    session: ArtifactRunSession,
    step: StepIdentity,
  ): Promise<ResolvedStep | null>;
  beginStep(
    session: ArtifactRunSession,
    step: StepIdentity,
  ): Promise<ArtifactStepSession>;
  commitStep(
    session: ArtifactRunSession,
    step: ArtifactStepSession,
    input: { readonly message: string },
  ): Promise<CommittedStep>;
  abortStep?(
    session: ArtifactRunSession,
    step: ArtifactStepSession,
    failure: CapsuleFailure,
  ): Promise<void>;
};

/** Public artifact layer handle. Construct via the `Artifacts` namespace. */
export type ArtifactLayer = {
  readonly kind: string;
};

/** Internal artifact layer handle. Public consumers only see `ArtifactLayer`. */
export type InternalArtifactLayer = ArtifactLayer & {
  readonly backend: ArtifactBackend;
};

export type WorkersArtifactLayer = ArtifactLayer & { readonly kind: "workers-binding" };
export type MemoryArtifactLayer = ArtifactLayer & { readonly kind: "memory" };
export type LocalNodeArtifactLayer = ArtifactLayer & { readonly kind: "local-node" };
export type LocalBridgeArtifactLayer = ArtifactLayer & { readonly kind: "local-bridge" };
export type HostedArtifactLayer = ArtifactLayer & { readonly kind: "hosted" };

export type InspectedRun = {
  readonly repo: string;
  readonly branch: string;
  readonly head?: string;
  readonly run: {
    readonly workflowName: string;
    readonly instanceId: string;
    readonly createdAt: string;
  } | null;
  readonly entries: ReadonlyArray<RunIndexEntry>;
};

export interface CapsulesService {
  capture<Input, Output>(
    spec: CapsuleSpec<Input, Output>,
  ): Promise<CapsuleRefs<Output>>;
  inspectRun(target: {
    readonly workflowName: string;
    readonly instanceId: string;
  }): Promise<InspectedRun>;
}
