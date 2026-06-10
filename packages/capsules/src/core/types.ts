/**
 * Core public and internal types for workflow-capsules.
 *
 * Workflow types are structural ("-Like") so this package never imports
 * `cloudflare:workers` at runtime and works with test doubles.
 */

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

/** Minimal Standard Schema v1 surface used for optional validation. */
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

/** Internal branded identifier types used by validation helpers. */
export type CapsuleName = string & { readonly __brand: "CapsuleName" };
export type CapsulePath = string & { readonly __brand: "CapsulePath" };

/** Internal body type retained for compact JSON evidence helpers. */
export type CapsuleFileBody =
  | string
  | Uint8Array
  | ArrayBuffer
  | Blob
  | ReadableStream<Uint8Array>
  | null
  | boolean
  | number
  | { readonly [key: string]: unknown }
  | ReadonlyArray<unknown>;

export type ProviderSummary = Readonly<Record<string, unknown>>;

export type ReconcileResult<Result> =
  | { readonly status: "found"; readonly result: Result }
  | { readonly status: "not_found" }
  | { readonly status: "inconclusive"; readonly reason?: string };

export type ReconcileContext<Request> = {
  readonly request: Request;
  readonly key: string;
  readonly workflow: WorkflowEventLike;
  readonly step: WorkflowStepContextLike;
  readonly attempt: number;
};

export type ExternalCallRecovery<Request, Result> =
  | "idempotent-call"
  | "fail-closed"
  | {
      readonly reconcile: (
        ctx: ReconcileContext<Request>,
      ) => Promise<ReconcileResult<Result>>;
    };

export type ExternalCallExecuteContext<Request> = {
  readonly request: Request;
  readonly key: string;
  readonly workflow: WorkflowEventLike;
  readonly step: WorkflowStepContextLike;
  readonly attempt: number;
};

export type ExternalCallSummaryContext<Request, Result> = {
  readonly request: Request;
  readonly result: Result;
  readonly key: string;
  readonly workflow: WorkflowEventLike;
  readonly step: WorkflowStepContextLike;
};

export type ExternalCallSpec<Request, Result> = {
  readonly name: string;
  readonly request?: StandardSchemaV1<unknown, Request>;
  readonly result?: StandardSchemaV1<unknown, Result>;
  readonly recovery: ExternalCallRecovery<Request, Result>;
  readonly execute: (ctx: ExternalCallExecuteContext<Request>) => Promise<Result>;
  readonly summary?: (
    ctx: ExternalCallSummaryContext<Request, Result>,
  ) => ProviderSummary;
};

export type ExternalCall<Request, Result> = ExternalCallSpec<Request, Result>;

export type ExternalCallRunContext<Request> = {
  readonly workflow: WorkflowEventLike;
  readonly step: WorkflowStepContextLike;
  readonly key: string;
  readonly request: Request;
};

export type Capsules = {
  call<Request, Result>(
    externalCall: ExternalCall<Request, Result>,
    context: ExternalCallRunContext<Request>,
  ): Promise<Result>;
};

export type CallIdentity = {
  readonly workflowName: string;
  readonly instanceId: string;
  readonly callName: string;
  readonly key: string;
  readonly keyHash: string;
  readonly requestDigest: string;
  readonly callDir: string;
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

export type ArtifactWriteSession = {
  stage(path: string, bytes: Uint8Array): void;
};

export type CommittedRecord = {
  readonly commit: string;
  readonly parent?: string;
};

export type ArtifactBackend = {
  readonly kind: string;
  openRun(input: OpenRunInput): Promise<ArtifactRunSession>;
  beginWrite(): Promise<ArtifactWriteSession>;
  commitWrite(
    session: ArtifactRunSession,
    write: ArtifactWriteSession,
    input: { readonly message: string },
  ): Promise<CommittedRecord>;
};

/** Public adapter handle. Construct via an adapter subpath module. */
export type CapsuleAdapter = {
  readonly kind: string;
};

/** Internal adapter handle with the backend implementation attached. */
export type InternalCapsuleAdapter = CapsuleAdapter & {
  readonly backend: ArtifactBackend;
};

export type CloudflareAdapter = CapsuleAdapter & { readonly kind: "cloudflare" };
export type MemoryAdapter = CapsuleAdapter & { readonly kind: "memory" };
export type LocalAdapter = CapsuleAdapter & { readonly kind: "local" };
export type RemoteAdapter = CapsuleAdapter & { readonly kind: "remote" };

export type CallRequestRecord = {
  readonly schemaVersion: 1;
  readonly callName: string;
  readonly keyHash: string;
  readonly requestDigest: string;
  readonly workflow: { readonly name: string; readonly instanceId: string };
  readonly step: { readonly name: string; readonly count: number };
  readonly createdAt: string;
};

export type StartedCallRecord = {
  readonly schemaVersion: 1;
  readonly status: "started";
  readonly attempt: number;
  readonly startedAt: string;
};

export type CommittedCallRecord<Result = unknown> = {
  readonly schemaVersion: 1;
  readonly status: "committed" | "reconciled";
  readonly attempt: number;
  readonly result: Result;
  readonly committedAt: string;
};

export type AttemptErrorRecord = {
  readonly schemaVersion: 1;
  readonly status: "error";
  readonly attempt: number;
  readonly error: {
    readonly name: string;
    readonly message: string;
  };
  readonly failedAt: string;
};
