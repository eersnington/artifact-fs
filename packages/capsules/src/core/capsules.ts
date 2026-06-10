import {
  CapsuleError,
  invalidExternalCall,
  reconcileFailed,
  sideEffectAmbiguous,
  sideEffectConflict,
  storageFailed,
} from "./errors.js";
import { hashExternalCallKey, hashExternalRequest, hashWorkflowRun } from "./content-digest.js";
import { validateCapsuleName } from "./validation.js";
import {
  DEFAULT_BRANCH,
  INIT_COMMIT_MESSAGE,
  RUN_JSON_PATH,
  callAttemptErrorPath,
  callAttemptStartedPath,
  callCommittedPath,
  callDirPath,
  callReconciledPath,
  callRequestPath,
  callStartedPath,
  callSummaryPath,
  commitMessageForCommitted,
  commitMessageForError,
  commitMessageForReconciled,
  commitMessageForStarted,
  runRepoName,
} from "./repo-layout.js";
import type {
  ArtifactBackend,
  ArtifactRunSession,
  CallIdentity,
  CallRequestRecord,
  CapsuleAdapter,
  Capsules,
  CommittedCallRecord,
  ExternalCall,
  ExternalCallRunContext,
  ExternalCallSpec,
  InternalCapsuleAdapter,
  ProviderSummary,
  ReconcileResult,
  StandardSchemaV1,
  StartedCallRecord,
  AttemptErrorRecord,
} from "./types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type CreateCapsulesOptions = {
  readonly adapter: CapsuleAdapter;
};

export function defineExternalCall<Request, Result>(
  spec: ExternalCallSpec<Request, Result>,
): ExternalCall<Request, Result> {
  validateExternalCallSpec(spec);
  return spec;
}

export function createCapsules(options: CreateCapsulesOptions): Capsules {
  return new CapsulesImpl(options.adapter);
}

class CapsulesImpl implements Capsules {
  private readonly adapter: InternalCapsuleAdapter;

  constructor(adapter: CapsuleAdapter) {
    this.adapter = adapter as InternalCapsuleAdapter;
  }

  async call<Request, Result>(
    externalCall: ExternalCall<Request, Result>,
    context: ExternalCallRunContext<Request>,
  ): Promise<Result> {
    validateExternalCallSpec(externalCall);
    const runContext = validateRunContext(context);
    const request = externalCall.request !== undefined
      ? await validateSchema(externalCall.request, context.request, externalCall.name, "request")
      : context.request;
    const identity = await resolveCallIdentity(externalCall.name, runContext, request);
    const session = await this.openRun(identity);
    await assertRequestCompatible(session, identity, runContext);

    const committed = await readJson<CommittedCallRecord<Result>>(
      session,
      callCommittedPath(identity.callDir),
    );
    if (committed !== null) {
      return validateStoredResult(externalCall, committed.result);
    }

    const reconciled = await readJson<CommittedCallRecord<Result>>(
      session,
      callReconciledPath(identity.callDir),
    );
    if (reconciled !== null) {
      return validateStoredResult(externalCall, reconciled.result);
    }

    const started = await readJson<StartedCallRecord>(
      session,
      callStartedPath(identity.callDir),
    );
    if (started !== null) {
      const recovered = await this.applyRecovery(externalCall, identity, runContext, request, session);
      if (recovered !== undefined) return recovered;
    }

    await this.recordStarted(session, identity, runContext);

    let result: Result;
    try {
      result = await externalCall.execute({
        request,
        key: context.key,
        workflow: context.workflow,
        step: context.step,
        attempt: context.step.attempt,
      });
    } catch (error) {
      await this.recordAttemptError(session, identity, runContext, error);
      throw error;
    }

    const validatedResult = externalCall.result !== undefined
      ? await validateSchema(externalCall.result, result, externalCall.name, "result")
      : result;
    const summary = externalCall.summary?.({
      request,
      result: validatedResult,
      key: context.key,
      workflow: context.workflow,
      step: context.step,
    });
    await this.recordCommitted(session, identity, runContext, validatedResult, summary, "committed");
    return validatedResult;
  }

  private async openRun(identity: CallIdentity): Promise<ArtifactRunSession> {
    const identityHash = await hashWorkflowRun({
      workflowName: identity.workflowName,
      instanceId: identity.instanceId,
    });
    try {
      return await this.adapter.backend.openRun({
        workflowName: identity.workflowName,
        instanceId: identity.instanceId,
        repoName: runRepoName(
          identity.workflowName,
          identity.instanceId,
          identityHash.slice("sha256:".length),
        ),
        branch: DEFAULT_BRANCH,
        initFiles: initRunFiles(identity.workflowName, identity.instanceId),
        initMessage: INIT_COMMIT_MESSAGE,
      });
    } catch (cause) {
      if (cause instanceof CapsuleError) throw cause;
      throw storageFailed(
        `Could not open call-history storage for workflow "${identity.workflowName}" instance ` +
          `"${identity.instanceId}". Provider code was not invoked; retry after fixing storage access.`,
        cause,
      );
    }
  }

  private async applyRecovery<Request, Result>(
    externalCall: ExternalCall<Request, Result>,
    identity: CallIdentity,
    runContext: ValidRunContext,
    request: Request,
    session: ArtifactRunSession,
  ): Promise<Result | undefined> {
    if (externalCall.recovery === "idempotent-call") return undefined;
    if (externalCall.recovery === "fail-closed") {
      throw ambiguous(identity, "A prior attempt crossed the external side-effect boundary but no committed result was recorded.");
    }

    let reconciliation: ReconcileResult<Result>;
    try {
      reconciliation = await externalCall.recovery.reconcile({
        request,
        key: runContext.key,
        workflow: runContext.workflow,
        step: runContext.step,
        attempt: runContext.step.attempt,
      });
    } catch (cause) {
      throw reconcileFailed(
        `Reconciliation for external call "${identity.callName}" failed after a prior started record. ` +
          `Provider code was not invoked. Retry after fixing the reconciliation path; prior records remain intact.`,
        cause,
      );
    }

    if (reconciliation.status === "found") {
      const result = externalCall.result !== undefined
        ? await validateSchema(externalCall.result, reconciliation.result, externalCall.name, "result")
        : reconciliation.result;
      const summary = externalCall.summary?.({
        request,
        result,
        key: runContext.key,
        workflow: runContext.workflow,
        step: runContext.step,
      });
      await this.recordCommitted(session, identity, runContext, result, summary, "reconciled");
      return result;
    }

    const reason = reconciliation.status === "inconclusive" && reconciliation.reason !== undefined
      ? ` Reconciliation was inconclusive: ${reconciliation.reason}.`
      : reconciliation.status === "not_found"
        ? " Reconciliation did not find a provider result; Capsules does not treat absence as safe to retry."
        : " Reconciliation was inconclusive.";
    throw ambiguous(
      identity,
      `A prior attempt crossed the external side-effect boundary but no committed result was recorded.${reason}`,
    );
  }

  private async recordStarted(
    session: ArtifactRunSession,
    identity: CallIdentity,
    runContext: ValidRunContext,
  ): Promise<void> {
    const now = new Date().toISOString();
    const requestRecord: CallRequestRecord = {
      schemaVersion: 1,
      callName: identity.callName,
      keyHash: identity.keyHash,
      requestDigest: identity.requestDigest,
      workflow: { name: identity.workflowName, instanceId: identity.instanceId },
      step: { name: runContext.step.step.name, count: runContext.step.step.count },
      createdAt: now,
    };
    const startedRecord: StartedCallRecord = {
      schemaVersion: 1,
      status: "started",
      attempt: runContext.step.attempt,
      startedAt: now,
    };
    const write = await this.adapter.backend.beginWrite();
    if ((await session.readFile(callRequestPath(identity.callDir))) === null) {
      writeJson(write, callRequestPath(identity.callDir), requestRecord);
    }
    writeJson(write, callStartedPath(identity.callDir), startedRecord);
    writeJson(write, callAttemptStartedPath(identity.callDir, runContext.step.attempt), startedRecord);
    await commitStorage(
      this.adapter.backend,
      session,
      write,
      commitMessageForStarted(identity.callName, runContext.step.attempt),
      `Could not persist the started record for external call "${identity.callName}". ` +
        `Provider code was not invoked; retry after fixing call-history storage.`,
    );
  }

  private async recordCommitted<Result>(
    session: ArtifactRunSession,
    identity: CallIdentity,
    runContext: ValidRunContext,
    result: Result,
    summary: ProviderSummary | undefined,
    status: "committed" | "reconciled",
  ): Promise<void> {
    const record: CommittedCallRecord<Result> = {
      schemaVersion: 1,
      status,
      attempt: runContext.step.attempt,
      result,
      committedAt: new Date().toISOString(),
    };
    const write = await this.adapter.backend.beginWrite();
    writeJson(write, status === "committed" ? callCommittedPath(identity.callDir) : callReconciledPath(identity.callDir), record);
    if (summary !== undefined) {
      writeJson(write, callSummaryPath(identity.callDir), summary);
    }
    await commitStorage(
      this.adapter.backend,
      session,
      write,
      status === "committed"
        ? commitMessageForCommitted(identity.callName, runContext.step.attempt)
        : commitMessageForReconciled(identity.callName, runContext.step.attempt),
      `Provider code for external call "${identity.callName}" returned, but Capsules could not persist the ${status} record. ` +
        `A retry must use the configured recovery policy; prior records remain intact.`,
      false,
    );
  }

  private async recordAttemptError(
    session: ArtifactRunSession,
    identity: CallIdentity,
    runContext: ValidRunContext,
    error: unknown,
  ): Promise<void> {
    const record: AttemptErrorRecord = {
      schemaVersion: 1,
      status: "error",
      attempt: runContext.step.attempt,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      },
      failedAt: new Date().toISOString(),
    };
    try {
      const write = await this.adapter.backend.beginWrite();
      writeJson(write, callAttemptErrorPath(identity.callDir, runContext.step.attempt), record);
      await this.adapter.backend.commitWrite(session, write, {
        message: commitMessageForError(identity.callName, runContext.step.attempt),
      });
    } catch {
      // Best effort only. The provider error must propagate to Workflows.
    }
  }
}

type ValidRunContext = {
  readonly workflow: ExternalCallRunContext<unknown>["workflow"];
  readonly step: ExternalCallRunContext<unknown>["step"];
  readonly key: string;
};

async function resolveCallIdentity(
  callName: string,
  context: ValidRunContext,
  request: unknown,
): Promise<CallIdentity> {
  const keyHash = await hashExternalCallKey(context.key);
  const requestDigest = await hashExternalRequest(request);
  return {
    workflowName: context.workflow.workflowName,
    instanceId: context.workflow.instanceId,
    callName,
    key: context.key,
    keyHash,
    requestDigest,
    callDir: callDirPath(keyHash),
  };
}

async function assertRequestCompatible(
  session: ArtifactRunSession,
  identity: CallIdentity,
  context: ValidRunContext,
): Promise<void> {
  const existing = await readJson<CallRequestRecord>(session, callRequestPath(identity.callDir));
  if (existing === null) return;
  if (existing.requestDigest === identity.requestDigest && existing.callName === identity.callName) return;
  throw sideEffectConflict(
    `External call key for "${identity.callName}" already has a recorded request for workflow ` +
      `"${identity.workflowName}" instance "${identity.instanceId}" step "${context.step.step.name}". ` +
      `Existing digest is ${existing.requestDigest}; new digest is ${identity.requestDigest}. ` +
      `Provider code was not invoked. Use the same request for this key or choose a new key.`,
  );
}

function validateRunContext<Request>(context: ExternalCallRunContext<Request>): ValidRunContext {
  if (typeof context.workflow?.workflowName !== "string" || context.workflow.workflowName.length === 0) {
    throw invalidExternalCall("capsules.call(...) requires workflow.workflowName. Pass the WorkflowEvent received by run().");
  }
  if (typeof context.workflow.instanceId !== "string" || context.workflow.instanceId.length === 0) {
    throw invalidExternalCall("capsules.call(...) requires workflow.instanceId. Pass the WorkflowEvent received by run().");
  }
  if (typeof context.step?.step?.name !== "string" || context.step.step.name.length === 0) {
    throw invalidExternalCall("capsules.call(...) requires step.step.name. Pass the WorkflowStepContext from step.do().");
  }
  if (typeof context.step.step.count !== "number" || typeof context.step.attempt !== "number") {
    throw invalidExternalCall("capsules.call(...) requires step.step.count and step.attempt. Pass the WorkflowStepContext from step.do().");
  }
  if (typeof context.key !== "string" || context.key.length === 0) {
    throw invalidExternalCall("capsules.call(...) requires a non-empty stable external side-effect key. Provider code was not invoked.");
  }
  return { workflow: context.workflow, step: context.step, key: context.key };
}

function validateExternalCallSpec<Request, Result>(
  spec: ExternalCallSpec<Request, Result>,
): void {
  validateCapsuleName(spec.name);
  if (typeof spec.execute !== "function") {
    throw invalidExternalCall(`External call "${spec.name}" requires an execute function.`);
  }
  if (
    spec.recovery !== "idempotent-call" &&
    spec.recovery !== "fail-closed" &&
    (spec.recovery === null || typeof spec.recovery !== "object" || typeof spec.recovery.reconcile !== "function")
  ) {
    throw invalidExternalCall(
      `External call "${spec.name}" requires recovery "idempotent-call", "fail-closed", or { reconcile }.`,
    );
  }
}

async function validateStoredResult<Request, Result>(
  externalCall: ExternalCall<Request, Result>,
  value: Result,
): Promise<Result> {
  return externalCall.result !== undefined
    ? validateSchema(externalCall.result, value, externalCall.name, "result")
    : value;
}

async function validateSchema<T>(
  schema: StandardSchemaV1<unknown, T>,
  value: unknown,
  callName: string,
  label: "request" | "result",
): Promise<T> {
  const result = await schema["~standard"].validate(value);
  if (result.issues !== undefined) {
    const detail = result.issues.map((issue) => issue.message).join("; ");
    throw invalidExternalCall(
      `External call "${callName}" ${label} failed schema validation: ${detail}. Provider code was not invoked when validation happened before execution.`,
    );
  }
  return result.value;
}

async function readJson<T>(session: ArtifactRunSession, path: string): Promise<T | null> {
  const bytes = await session.readFile(path);
  if (bytes === null) return null;
  return JSON.parse(decoder.decode(bytes)) as T;
}

function writeJson(
  write: { stage(path: string, bytes: Uint8Array): void },
  path: string,
  value: unknown,
): void {
  write.stage(path, encoder.encode(JSON.stringify(value, null, 2) + "\n"));
}

async function commitStorage(
  backend: ArtifactBackend,
  session: ArtifactRunSession,
  write: { stage(path: string, bytes: Uint8Array): void },
  message: string,
  failureMessage: string,
  retryable = true,
): Promise<void> {
  try {
    await backend.commitWrite(session, write, { message });
  } catch (cause) {
    if (cause instanceof CapsuleError) throw cause;
    throw storageFailed(failureMessage, cause, { retryable });
  }
}

function initRunFiles(workflowName: string, instanceId: string): Map<string, Uint8Array> {
  const runJson = {
    schemaVersion: 1,
    workflowName,
    instanceId,
    createdAt: new Date().toISOString(),
  };
  return new Map([
    [RUN_JSON_PATH, encoder.encode(JSON.stringify(runJson, null, 2) + "\n")],
  ]);
}

function ambiguous(identity: CallIdentity, reason: string): CapsuleError {
  return sideEffectAmbiguous(
    `${reason} External call "${identity.callName}" with key hash ${identity.keyHash} is ambiguous. ` +
      `Provider code was not invoked on this retry. Reconcile provider state manually or use a recovery policy that can prove the result.`,
  );
}
