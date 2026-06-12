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
    ) => StandardSchemaResult<Out> | Promise<StandardSchemaResult<Out>>;
  };
  readonly "~types"?: { readonly input: In; readonly output: Out } | undefined;
}

export type StandardSchemaResult<Out> =
  | { readonly value: Out; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<{ readonly message: string }> };

export type ReconcileResult<Result> =
  | { readonly status: "found"; readonly result: Result }
  | { readonly status: "not_found" }
  | { readonly status: "inconclusive"; readonly reason?: string };

export type ExternalCallContext<Request> = {
  readonly request: Request;
  readonly key: string;
  readonly workflow: WorkflowEventLike;
  readonly step: WorkflowStepContextLike;
  readonly attempt: number;
};

export type ReconcileContext<Request> = ExternalCallContext<Request>;
export type ExternalCallExecuteContext<Request> = ExternalCallContext<Request>;

export type ExternalCallSummaryContext<Request, Result> =
  ExternalCallContext<Request> & {
    readonly result: Result;
  };

export type ExternalCallRecovery<Request, Result> =
  | "idempotent-call"
  | "fail-closed"
  | {
      readonly reconcile: (
        ctx: ReconcileContext<Request>,
      ) => Promise<ReconcileResult<Result>>;
    };

export type ExternalCallSpec<Request, Result> = {
  readonly name: string;
  readonly request?: StandardSchemaV1<unknown, Request>;
  readonly result?: StandardSchemaV1<unknown, Result>;
  readonly recovery: ExternalCallRecovery<Request, Result>;
  readonly execute: (ctx: ExternalCallExecuteContext<Request>) => Promise<Result>;
  readonly summary?: (
    ctx: ExternalCallSummaryContext<Request, Result>,
  ) => Readonly<Record<string, unknown>>;
};

export type ExternalCall<Request, Result> = ExternalCallSpec<Request, Result>;

export type ExternalCallRunContext<Request> = {
  readonly workflow: WorkflowEventLike;
  readonly step: WorkflowStepContextLike;
  readonly key: string;
  readonly request: Request;
};

export type Stepdaddy = {
  call<Request, Result>(
    externalCall: ExternalCall<Request, Result>,
    context: ExternalCallRunContext<Request>,
  ): Promise<Result>;
};

export type CallPaths = {
  readonly request: string;
  readonly committed: string;
  readonly attemptStarted: string;
  readonly attemptError: string;
};

export type CallIdentity = {
  readonly workflowName: string;
  readonly instanceId: string;
  readonly callName: string;
  readonly keyHash: string;
  readonly requestDigest: string;
  readonly repoName: string;
  readonly paths: CallPaths;
};

export type OpenRunInput = {
  readonly workflowName: string;
  readonly instanceId: string;
  readonly repoName: string;
  readonly branch: string;
  readonly initFiles: ReadonlyMap<string, Uint8Array>;
  readonly initMessage: string;
};

export type CommitResult = {
  readonly commit: string;
  readonly parent?: string;
};

export type CallStoreRun = {
  readonly repo: string;
  readonly branch: string;
  readHead(): Promise<string | undefined>;
  readFile(path: string): Promise<Uint8Array | null>;
  commitFiles(input: {
    readonly files: ReadonlyMap<string, Uint8Array>;
    readonly message: string;
  }): Promise<CommitResult>;
};

export type CallStore = {
  readonly kind: string;
  openRun(input: OpenRunInput): Promise<CallStoreRun>;
};

/** Public adapter handle. Construct via an adapter subpath module. */
export type StepdaddyAdapter = {
  readonly kind: string;
};

export type InternalStepdaddyAdapter = StepdaddyAdapter & {
  readonly store: CallStore;
};

export type CloudflareAdapter = StepdaddyAdapter & { readonly kind: "cloudflare" };
export type MemoryAdapter = StepdaddyAdapter & { readonly kind: "memory" };
export type LocalAdapter = StepdaddyAdapter & { readonly kind: "local" };
export type RemoteAdapter = StepdaddyAdapter & { readonly kind: "remote" };

export type CallRequestRecord = {
  readonly schemaVersion: 1;
  readonly callName: string;
  readonly keyHash: string;
  readonly requestDigest: string;
  readonly workflow: { readonly name: string; readonly instanceId: string };
  readonly step: { readonly name: string; readonly count: number };
  readonly createdAt: string;
};

export type CommittedCallRecord<Result = unknown> = {
  readonly schemaVersion: 1;
  readonly status: "committed" | "reconciled";
  readonly attempt: number;
  readonly result: Result;
  readonly summary?: Readonly<Record<string, unknown>>;
  readonly committedAt: string;
};
