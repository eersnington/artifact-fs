import { CapsuleError, invalidRequest, toCapsuleFailure } from "./errors.js";
import {
  slugify,
  validateCapsuleName,
} from "./validation.js";
import type {
  CapsuleAdapter,
  ArtifactRunSession,
  ArtifactStepSession,
  CapsuleRefs,
  CapsuleRunContext,
  CapsuleSpec,
  CaptureOptions,
  CapsulesService,
  InspectedRun,
  InternalCapsuleAdapter,
  OpenRunInput,
  RunIndexEntry,
  StandardSchemaV1,
  StepIdentity,
  StepManifest,
} from "./types.js";
import { AttemptRecorder } from "./attempt-recorder.js";
import { hashCapsuleInput, hashWorkflowRun } from "./content-digest.js";
import {
  DEFAULT_BRANCH,
  RUN_INDEX_PATH,
  RUN_JSON_PATH,
  attemptDirPath,
  commitMessageFor,
  failureCommitMessageFor,
  failurePath,
  INIT_COMMIT_MESSAGE,
  inputHashPath,
  manifestPath,
  outputPath,
  runRepoName,
  stepDirName,
} from "./repo-layout.js";
import { appendIndexEntry, readRunIndex } from "./run-index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Serialized `output` must stay far below the 1 MiB non-stream `step.do()`
 * result limit, because CapsuleRefs wraps it with metadata and the whole
 * object is persisted as Workflow state.
 */
const MAX_OUTPUT_BYTES = 256 * 1024;

export type CreateCapsulesOptions = {
  readonly adapter: CapsuleAdapter;
  readonly maxOutputBytes?: number;
  readonly maxFileBytes?: number;
};

export function createCapsules(options: CreateCapsulesOptions): CapsulesService {
  return new CapsulesImpl(options.adapter, optionalLimits(options));
}

class CapsulesImpl implements CapsulesService {
  private readonly adapter: InternalCapsuleAdapter;
  private readonly maxOutputBytes: number;
  private readonly maxFileBytes: number | undefined;

  constructor(
    adapter: CapsuleAdapter,
    options: { readonly maxOutputBytes?: number; readonly maxFileBytes?: number } = {},
  ) {
    this.adapter = adapter as InternalCapsuleAdapter;
    this.maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
    this.maxFileBytes = options.maxFileBytes;
  }

  async capture<Input, Output>(
    specOrOptions: CapsuleSpec<Input, Output> | CaptureOptions<Input>,
    run?: (ctx: CapsuleRunContext<Input>) => Promise<Output>,
  ): Promise<CapsuleRefs<Output>> {
    const spec = normalizeCaptureSpec(specOrOptions, run);
    const capsuleName = validateCapsuleName(spec.name);
    const input = spec.inputSchema
      ? await validateInput(spec.inputSchema, spec.input, capsuleName)
      : spec.input;
    const identityCtx = await resolveIdentity(spec, input);

    const backend = this.adapter.backend;
    const session = await backend.openRun(identityCtx.openRun);
    const step = identityCtx.step;

    const existing = await backend.resolveStep(session, step);
    if (existing !== null) {
      if (existing.manifest.input.hash !== step.inputHash) {
        throw new CapsuleError(
      "CAPSULE_CONFLICT",
          `Capsule "${capsuleName}" already has a committed logical step at ${step.stepDir} ` +
            `with input hash ${existing.manifest.input.hash}, but this call provided ` +
            `${step.inputHash}. The committed artifact is intact and the callback was not re-run. ` +
            `Use a different step name/count or pass the same input.`,
        );
      }
      return refsFromResolved<Output>(this.adapter.kind, session, existing);
    }

    const stepSession = await backend.beginStep(session, step);
    const recorder = new AttemptRecorder(
      identityCtx,
      stepSession,
      spec.dedupe?.key,
      this.maxFileBytes,
    );
    const startedAt = new Date();
    const parentAtStart = await session.head();

    let output: Output;
    try {
      output = await spec.run({
        input,
        files: {
          write: (path, body, options) => recorder.write(path, body, options),
        },
        effects: {
          record: (kind, record) => recorder.recordEffect(kind, record),
        },
        ...(step.idempotencyKey !== undefined && {
          idempotencyKey: step.idempotencyKey,
        }),
      });
    } catch (error) {
      await this.recordFailure(session, stepSession, recorder, error);
      throw error;
    }

    const outputBytes = serializeOutput(capsuleName, output, this.maxOutputBytes);
    const manifest = recorder.buildManifest(startedAt, output, {
      repo: session.repo,
      branch: session.branch,
      ...(parentAtStart !== undefined && { parent: parentAtStart }),
    });
    stepSession.stage(outputPath(step.attemptDir), outputBytes);
    stepSession.stage(
      inputHashPath(step.attemptDir),
      encoder.encode(JSON.stringify({ hash: step.inputHash }, null, 2) + "\n"),
    );
    stepSession.stage(
      manifestPath(step.attemptDir),
      encoder.encode(JSON.stringify(manifest, null, 2) + "\n"),
    );
    await stageIndexEntry(session, stepSession, {
      stepDir: step.stepDir,
      attempt: step.attempt,
      capsule: capsuleName,
      inputHash: step.inputHash,
      status: "committed",
      manifestPath: manifestPath(step.attemptDir),
    });

    const committed = await backend.commitStep(session, stepSession, {
      message: commitMessageFor(step),
    });

    return {
      capsule: {
        name: capsuleName,
        id: step.capsuleId,
        inputHash: step.inputHash,
        ...(step.idempotencyKey !== undefined && {
          idempotencyKey: step.idempotencyKey,
        }),
        ...(spec.dedupe !== undefined && { dedupeKey: spec.dedupe.key }),
      },
      workflow: {
        name: identityCtx.workflowName,
        instanceId: identityCtx.instanceId,
        stepName: step.stepName,
        stepCount: step.stepCount,
        attempt: step.attempt,
      },
      artifact: {
        adapter: this.adapter.kind,
        repo: session.repo,
        branch: session.branch,
        commit: committed.commit,
        ...(committed.parent !== undefined && { parent: committed.parent }),
      },
      files: recorder.fileRefs(),
      effects: recorder.effectRefs(),
      effectCount: recorder.effectRefs().length,
      output,
      manifestPath: manifestPath(step.attemptDir),
      ...(committed.parent !== undefined && {
        diff: { base: committed.parent, head: committed.commit },
      }),
    };
  }

  async inspectRun(target: {
    workflowName: string;
    instanceId: string;
  }): Promise<InspectedRun> {
    const identityHash = await hashWorkflowRun({
      workflowName: target.workflowName,
      instanceId: target.instanceId,
    });
    const repoName = runRepoName(
      target.workflowName,
      target.instanceId,
      identityHash.slice("sha256:".length),
    );
    const session = await this.adapter.backend.openRun({
      workflowName: target.workflowName,
      instanceId: target.instanceId,
      repoName,
      branch: DEFAULT_BRANCH,
      initFiles: initRunFiles(target.workflowName, target.instanceId),
      initMessage: INIT_COMMIT_MESSAGE,
    });
    const index = await readRunIndex(session);
    const runJson = await session.readFile(RUN_JSON_PATH);
    const head = await session.head();
    return {
      repo: session.repo,
      branch: session.branch,
      ...(head !== undefined && { head }),
      run:
        runJson !== null
          ? (JSON.parse(decoder.decode(runJson)) as InspectedRun["run"])
          : null,
      entries: index.entries,
    };
  }

  /**
   * Failure policy `auto`: write a failure manifest and commit it when the
   * attempt crossed a side-effect boundary (files staged, effects recorded,
   * or an idempotency key present). Otherwise skip the empty failure commit.
   * The original error is always rethrown by the caller so `step.do()`
   * retries keep working; a failed failure-commit must never mask it.
   */
  private async recordFailure(
    session: ArtifactRunSession,
    stepSession: ArtifactStepSession,
    recorder: AttemptRecorder,
    error: unknown,
  ): Promise<void> {
    const step = stepSession.identity;
    const failure = toCapsuleFailure(error);
    const shouldRecord =
      stepSession.hasStagedFiles() ||
      recorder.effects().length > 0 ||
      step.idempotencyKey !== undefined;
    if (!shouldRecord) return;

    try {
      const failureManifest = recorder.buildFailureManifest(failure, error);
      stepSession.stage(
        failurePath(step.attemptDir),
        encoder.encode(JSON.stringify(failureManifest, null, 2) + "\n"),
      );
      await stageIndexEntry(session, stepSession, {
        stepDir: step.stepDir,
        attempt: step.attempt,
        capsule: step.capsuleName,
        inputHash: step.inputHash,
        status: "failed",
        manifestPath: failurePath(step.attemptDir),
      });
      const backend = this.adapter.backend;
      if (backend.abortStep !== undefined) {
        await backend.abortStep(session, stepSession, failure);
      } else {
        await backend.commitStep(session, stepSession, {
          message: failureCommitMessageFor(step),
        });
      }
    } catch {
      // Best effort only. The committed history is unchanged; the original
      // producer error propagates to step.do() for retry.
    }
  }
}

type IdentityContext = {
  workflowName: string;
  instanceId: string;
  step: StepIdentity;
  openRun: OpenRunInput;
};

async function resolveIdentity(
  spec: CapsuleSpec<unknown, unknown>,
  input: unknown,
): Promise<IdentityContext> {
  const workflowName = spec.workflow?.workflowName;
  const instanceId = spec.workflow?.instanceId;
  if (typeof workflowName !== "string" || workflowName.length === 0) {
    throw invalidRequest(
      "capture() requires `workflow` with a non-empty `workflowName`. " +
        "Pass the WorkflowEvent received by run().",
    );
  }
  if (typeof instanceId !== "string" || instanceId.length === 0) {
    throw invalidRequest(
      "capture() requires `workflow` with a non-empty `instanceId`. " +
        "Pass the WorkflowEvent received by run().",
    );
  }
  const stepName = spec.step?.step?.name;
  const stepCount = spec.step?.step?.count;
  const attempt = spec.step?.attempt;
  if (
    typeof stepName !== "string" ||
    typeof stepCount !== "number" ||
    typeof attempt !== "number"
  ) {
    throw invalidRequest(
      "capture() requires `step` with `step.name`, `step.count`, and `attempt`. " +
        "Pass the WorkflowStepContext that step.do() provides to its callback.",
    );
  }
  const inputHash = await hashCapsuleInput(input);
  const identityHash = await hashWorkflowRun({ workflowName, instanceId });
  const stepDir = stepDirName(stepCount, stepName);
  const step: StepIdentity = {
    capsuleName: spec.name,
    capsuleId: spec.id ?? `${instanceId}:${slugify(stepName)}:${stepCount}`,
    stepName,
    stepCount,
    attempt,
    inputHash,
    ...(spec.idempotencyKey !== undefined && {
      idempotencyKey: spec.idempotencyKey,
    }),
    stepDir,
    attemptDir: attemptDirPath(stepDir, attempt),
  };
  return {
    workflowName,
    instanceId,
    step,
    openRun: {
      workflowName,
      instanceId,
      repoName: runRepoName(
        workflowName,
        instanceId,
        identityHash.slice("sha256:".length),
      ),
      branch: DEFAULT_BRANCH,
      initFiles: initRunFiles(workflowName, instanceId),
      initMessage: INIT_COMMIT_MESSAGE,
    },
  };
}

function initRunFiles(
  workflowName: string,
  instanceId: string,
): Map<string, Uint8Array> {
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

async function stageIndexEntry(
  session: ArtifactRunSession,
  stepSession: ArtifactStepSession,
  entry: RunIndexEntry,
): Promise<void> {
  const index = await readRunIndex(session);
  stepSession.stage(RUN_INDEX_PATH, appendIndexEntry(index, entry));
}

function serializeOutput(
  capsuleName: string,
  output: unknown,
  maxOutputBytes: number,
): Uint8Array {
  let json: string;
  try {
    json = JSON.stringify(output ?? null, null, 2) + "\n";
  } catch (cause) {
    throw new CapsuleError(
      "INVALID_CAPSULE_REQUEST",
      `Capsule "${capsuleName}" returned an output that cannot be JSON-serialized. ` +
        `Return small serializable refs (ids, paths, labels); keep file contents in files.write().`,
      { cause },
    );
  }
  const bytes = encoder.encode(json);
  if (bytes.byteLength > maxOutputBytes) {
    throw new CapsuleError(
      "INVALID_CAPSULE_REQUEST",
      `Capsule "${capsuleName}" returned ${bytes.byteLength} bytes of output; the limit is ` +
        `${maxOutputBytes} bytes because output is stored as Workflow state. ` +
        `Write large content with files.write() and return its path instead. ` +
        `All files written before this error were not committed.`,
    );
  }
  return bytes;
}

async function validateInput<Input>(
  schema: StandardSchemaV1<unknown, Input>,
  input: unknown,
  capsuleName: string,
): Promise<Input> {
  const result = await schema["~standard"].validate(input);
  if (result.issues !== undefined) {
    const detail = result.issues.map((issue) => issue.message).join("; ");
    throw invalidRequest(
      `Capsule "${capsuleName}" input failed schema validation: ${detail}. ` +
        `Nothing was written or committed.`,
    );
  }
  return result.value;
}

function refsFromResolved<Output>(
  adapterKind: string,
  session: ArtifactRunSession,
  resolved: { manifest: StepManifest; commit: string; parent?: string },
): CapsuleRefs<Output> {
  return {
    capsule: {
      name: resolved.manifest.capsule.name,
      id: resolved.manifest.capsule.id,
      inputHash: resolved.manifest.input.hash,
      ...(resolved.manifest.capsule.idempotencyKey !== undefined && {
        idempotencyKey: resolved.manifest.capsule.idempotencyKey,
      }),
      ...(resolved.manifest.capsule.dedupeKey !== undefined && {
        dedupeKey: resolved.manifest.capsule.dedupeKey,
      }),
    },
    workflow: {
      name: resolved.manifest.workflow.name,
      instanceId: resolved.manifest.workflow.instanceId,
      stepName: resolved.manifest.step.name,
      stepCount: resolved.manifest.step.count,
      attempt: resolved.manifest.step.attempt,
    },
    artifact: {
      adapter: adapterKind,
      repo: session.repo,
      branch: session.branch,
      commit: resolved.commit,
      ...(resolved.parent !== undefined && { parent: resolved.parent }),
    },
    files: { ...resolved.manifest.exposedFiles },
    effects: resolved.manifest.effects.map((effect) => ({
      kind: effect.kind,
      path: effect.path,
      seq: effect.seq,
      ...(effect.externalId !== undefined && { externalId: effect.externalId }),
      ...(effect.httpStatus !== undefined && { httpStatus: effect.httpStatus }),
      ...(effect.idempotencyKey !== undefined && {
        idempotencyKey: effect.idempotencyKey,
      }),
      ...(effect.request !== undefined && { request: effect.request }),
      ...(effect.response !== undefined && { response: effect.response }),
    })),
    output: resolved.manifest.output as Output,
    effectCount: resolved.manifest.effects.length,
    manifestPath: manifestPath(
      attemptDirPath(
        stepDirName(resolved.manifest.step.count, resolved.manifest.step.name),
        resolved.manifest.step.attempt,
      ),
    ),
    ...(resolved.parent !== undefined && {
      diff: { base: resolved.parent, head: resolved.commit },
    }),
  };
}

function optionalLimits(options: CreateCapsulesOptions): {
  readonly maxOutputBytes?: number;
  readonly maxFileBytes?: number;
} {
  return {
    ...(options.maxOutputBytes !== undefined && {
      maxOutputBytes: options.maxOutputBytes,
    }),
    ...(options.maxFileBytes !== undefined && {
      maxFileBytes: options.maxFileBytes,
    }),
  };
}

function normalizeCaptureSpec<Input, Output>(
  specOrOptions: CapsuleSpec<Input, Output> | CaptureOptions<Input>,
  run: ((ctx: CapsuleRunContext<Input>) => Promise<Output>) | undefined,
): CapsuleSpec<Input, Output> {
  if (run !== undefined) {
    return { ...specOrOptions, run } as CapsuleSpec<Input, Output>;
  }
  if ("run" in specOrOptions && typeof specOrOptions.run === "function") {
    return specOrOptions as CapsuleSpec<Input, Output>;
  }
  throw invalidRequest(
    "capture() requires a producer callback. Pass capture(options, async (ctx) => ...), " +
      "or include `run` on the capture spec.",
  );
}
