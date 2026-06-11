import {
  CapsuleError,
  invalidExternalCall,
  reconcileFailed,
  sideEffectAmbiguous,
  sideEffectConflict,
  storageFailed,
} from "./errors.js";
import type {
  CallIdentity,
  CallRequestRecord,
  CallStoreRun,
  CapsuleAdapter,
  Capsules,
  CommittedCallRecord,
  ExternalCall,
  ExternalCallRunContext,
  ExternalCallSpec,
  InternalCapsuleAdapter,
  ReconcileResult,
  StandardSchemaV1,
} from "./types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const BRANCH = "main";
const RUN_JSON_PATH = ".capsule/run.json";
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;

export type CreateCapsulesOptions = {
  readonly adapter: CapsuleAdapter;
};

export function defineExternalCall<Request, Result>(
  spec: ExternalCallSpec<Request, Result>,
): ExternalCall<Request, Result> {
  assertExternalCall(spec);
  return spec;
}

export function createCapsules(options: CreateCapsulesOptions): Capsules {
  const store = (options.adapter as InternalCapsuleAdapter).store;

  return {
    async call<Request, Result>(
      externalCall: ExternalCall<Request, Result>,
      context: ExternalCallRunContext<Request>,
    ): Promise<Result> {
      assertExternalCall(externalCall);
      assertRunContext(context);

      const request = externalCall.request === undefined
        ? context.request
        : await parseSchema(externalCall.request, context.request, externalCall.name, "request");
      const identity = await identifyCall(externalCall.name, context, request);
      const run = await openRun(store, identity);

      const existingRequestBytes = await run.readFile(identity.paths.request);
      const existingRequest = existingRequestBytes === null
        ? null
        : (JSON.parse(decoder.decode(existingRequestBytes)) as CallRequestRecord);
      if (
        existingRequest !== null &&
        (existingRequest.callName !== identity.callName ||
          existingRequest.requestDigest !== identity.requestDigest)
      ) {
        throw sideEffectConflict(
          `External call key for "${identity.callName}" already has a recorded request. ` +
            `Existing digest is ${existingRequest.requestDigest}; new digest is ${identity.requestDigest}. ` +
            `Provider code was not invoked. Use the same request for this key or choose a new key.`,
        );
      }

      const committedBytes = await run.readFile(identity.paths.committed);
      if (committedBytes !== null) {
        const committed = JSON.parse(decoder.decode(committedBytes)) as CommittedCallRecord<Result>;
        return externalCall.result === undefined
          ? committed.result
          : parseSchema(externalCall.result, committed.result, externalCall.name, "result");
      }

      const priorStarted = existingRequest !== null;
      let resultStatus: "committed" | "reconciled" = "committed";
      let result: Result;

      if (priorStarted && externalCall.recovery === "fail-closed") {
        throw sideEffectAmbiguous(
          `A prior attempt crossed the external side-effect boundary but no committed result was recorded. ` +
            `External call "${identity.callName}" with key hash ${identity.keyHash} is ambiguous. ` +
            `Provider code was not invoked on this retry. Reconcile provider state manually or use a recovery policy that can prove the result.`,
        );
      }

      if (priorStarted && typeof externalCall.recovery === "object") {
        let reconciliation: ReconcileResult<Result>;
        try {
          reconciliation = await externalCall.recovery.reconcile({
            request,
            key: context.key,
            workflow: context.workflow,
            step: context.step,
            attempt: context.step.attempt,
          });
        } catch (cause) {
          throw reconcileFailed(
            `Reconciliation for external call "${identity.callName}" failed after a prior started record. ` +
              `Provider code was not invoked. Retry after fixing the reconciliation path; prior records remain intact.`,
            cause,
          );
        }

        if (reconciliation.status !== "found") {
          const detail = reconciliation.status === "not_found"
            ? " Reconciliation did not find a provider result; absence is not safe to retry."
            : ` Reconciliation was inconclusive${reconciliation.reason === undefined ? "." : `: ${reconciliation.reason}.`}`;
          throw sideEffectAmbiguous(
            `A prior attempt crossed the external side-effect boundary but no committed result was recorded.${detail} ` +
              `External call "${identity.callName}" with key hash ${identity.keyHash} is ambiguous. ` +
              `Provider code was not invoked on this retry. Reconcile provider state manually or use a recovery policy that can prove the result.`,
          );
        }

        result = reconciliation.result;
        resultStatus = "reconciled";
      } else {
        await recordStarted(run, identity, context, existingRequest === null);
        try {
          result = await externalCall.execute({
            request,
            key: context.key,
            workflow: context.workflow,
            step: context.step,
            attempt: context.step.attempt,
          });
        } catch (error) {
          await recordProviderError(run, identity, context, error);
          throw error;
        }
      }

      const parsedResult = externalCall.result === undefined
        ? result
        : await parseSchema(externalCall.result, result, externalCall.name, "result");
      const summary = externalCall.summary?.({
        request,
        result: parsedResult,
        key: context.key,
        workflow: context.workflow,
        step: context.step,
        attempt: context.step.attempt,
      });
      const committedRecord: CommittedCallRecord<Result> = {
        schemaVersion: 1,
        status: resultStatus,
        attempt: context.step.attempt,
        result: parsedResult,
        ...(summary === undefined ? {} : { summary }),
        committedAt: new Date().toISOString(),
      };
      await commitFiles(
        run,
        new Map([
          [
            identity.paths.committed,
            encoder.encode(JSON.stringify(committedRecord, null, 2) + "\n"),
          ],
        ]),
        `capsules: ${identity.callName} attempt ${context.step.attempt} ${resultStatus}`,
        `Provider code for external call "${identity.callName}" returned, but Capsules could not persist the result record. ` +
          `A retry must use the configured recovery policy; prior records remain intact.`,
        false,
      );
      return parsedResult;
    },
  };
}

async function openRun(
  store: InternalCapsuleAdapter["store"],
  identity: CallIdentity,
): Promise<CallStoreRun> {
  try {
    return await store.openRun({
      workflowName: identity.workflowName,
      instanceId: identity.instanceId,
      repoName: identity.repoName,
      branch: BRANCH,
      initFiles: new Map([
        [
          RUN_JSON_PATH,
          encoder.encode(
            JSON.stringify(
              {
                schemaVersion: 1,
                workflowName: identity.workflowName,
                instanceId: identity.instanceId,
                createdAt: new Date().toISOString(),
              },
              null,
              2,
            ) + "\n",
          ),
        ],
      ]),
      initMessage: "capsules: init workflow run",
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

async function recordStarted<Request>(
  run: CallStoreRun,
  identity: CallIdentity,
  context: ExternalCallRunContext<Request>,
  writeRequest: boolean,
): Promise<void> {
  const now = new Date().toISOString();
  const files = new Map<string, Uint8Array>([
    [
      identity.paths.attemptStarted,
      encoder.encode(
        JSON.stringify(
          { schemaVersion: 1, status: "started", attempt: context.step.attempt, startedAt: now },
          null,
          2,
        ) + "\n",
      ),
    ],
  ]);
  if (writeRequest) {
    files.set(
      identity.paths.request,
      encoder.encode(
        JSON.stringify(
          {
            schemaVersion: 1,
            callName: identity.callName,
            keyHash: identity.keyHash,
            requestDigest: identity.requestDigest,
            workflow: { name: identity.workflowName, instanceId: identity.instanceId },
            step: { name: context.step.step.name, count: context.step.step.count },
            createdAt: now,
          } satisfies CallRequestRecord,
          null,
          2,
        ) + "\n",
      ),
    );
  }
  await commitFiles(
    run,
    files,
    `capsules: ${identity.callName} attempt ${context.step.attempt} started`,
    `Could not persist the started record for external call "${identity.callName}". ` +
      `Provider code was not invoked; retry after fixing call-history storage.`,
  );
}

async function recordProviderError<Request>(
  run: CallStoreRun,
  identity: CallIdentity,
  context: ExternalCallRunContext<Request>,
  error: unknown,
): Promise<void> {
  try {
    await run.commitFiles({
      message: `capsules: ${identity.callName} attempt ${context.step.attempt} error`,
      files: new Map([
        [
          identity.paths.attemptError,
          encoder.encode(
            JSON.stringify(
              {
                schemaVersion: 1,
                status: "error",
                attempt: context.step.attempt,
                error: {
                  name: error instanceof Error ? error.name : "Error",
                  message: error instanceof Error ? error.message : String(error),
                },
                failedAt: new Date().toISOString(),
              },
              null,
              2,
            ) + "\n",
          ),
        ],
      ]),
    });
  } catch {
    // Best effort only. The provider error must propagate to Workflows.
  }
}

async function identifyCall<Request>(
  callName: string,
  context: ExternalCallRunContext<Request>,
  request: Request,
): Promise<CallIdentity> {
  const keyDigest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(JSON.stringify({ key: context.key })),
  );
  const keyHash = `sha256:${[...new Uint8Array(keyDigest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;

  const requestDigestBytes = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(JSON.stringify(request)),
  );
  const requestDigest = `sha256:${[...new Uint8Array(requestDigestBytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;

  const workflow = context.workflow.workflowName.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^[-]+|[-]+$/g, "") || "run";
  const instance = context.workflow.instanceId.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^[-]+|[-]+$/g, "") || "run";
  const fullRepoName = `capsule-${workflow}-${instance}`;
  let repoName = fullRepoName;
  if (repoName.length > 100) {
    const repoDigest = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(JSON.stringify({
        workflowName: context.workflow.workflowName,
        instanceId: context.workflow.instanceId,
      })),
    );
    const repoHash = [...new Uint8Array(repoDigest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const suffix = repoHash.slice(0, 8);
    const budget = 100 - "capsule-".length - suffix.length - 2;
    const workflowBudget = Math.ceil(budget / 2);
    const instanceBudget = budget - workflowBudget;
    repoName = `capsule-${workflow.slice(0, workflowBudget)}-${instance.slice(0, instanceBudget)}-${suffix}`;
  }
  const keySegment = keyHash.slice("sha256:".length);
  const basePath = `.capsule/by-key/${keySegment}`;
  const attempt = String(context.step.attempt).padStart(3, "0");

  return {
    workflowName: context.workflow.workflowName,
    instanceId: context.workflow.instanceId,
    callName,
    keyHash,
    requestDigest,
    repoName,
    paths: {
      request: `${basePath}/request.json`,
      committed: `${basePath}/committed.json`,
      attemptStarted: `${basePath}/attempts/${attempt}-started.json`,
      attemptError: `${basePath}/attempts/${attempt}-error.json`,
    },
  };
}

async function commitFiles(
  run: CallStoreRun,
  files: ReadonlyMap<string, Uint8Array>,
  message: string,
  failureMessage: string,
  retryable = true,
): Promise<void> {
  try {
    await run.commitFiles({ files, message });
  } catch (cause) {
    if (cause instanceof CapsuleError) throw cause;
    throw storageFailed(failureMessage, cause, { retryable });
  }
}

function assertExternalCall<Request, Result>(spec: ExternalCallSpec<Request, Result>): void {
  if (!NAME_PATTERN.test(spec.name)) {
    throw invalidExternalCall(
      `External call name "${spec.name}" is invalid. Use 1-100 lowercase letters, digits, ".", "_", and "-", starting with a letter or digit.`,
    );
  }
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

function assertRunContext<Request>(context: ExternalCallRunContext<Request>): void {
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
}

async function parseSchema<T>(
  schema: StandardSchemaV1<unknown, T>,
  value: unknown,
  callName: string,
  label: "request" | "result",
): Promise<T> {
  const result = await schema["~standard"].validate(value);
  if (result.issues !== undefined) {
    throw invalidExternalCall(
      `External call "${callName}" ${label} failed schema validation: ${result.issues.map((issue) => issue.message).join("; ")}.`,
    );
  }
  return result.value;
}
