import { CapsuleError, invalidRequest, toCapsuleFailure } from "./errors.js";
import {
  slugify,
  validateCapsuleName,
  validateCapsulePath,
} from "./validation.js";
import type {
  CapsuleAdapter,
  ArtifactRunSession,
  ArtifactStepSession,
  CapsuleEffectRecordInput,
  CapsuleEffectSnapshot,
  CapsuleEffectSnapshotOptions,
  CapsuleFileBody,
  CapsuleFileOptions,
  CapsuleFileRef,
  CapsuleEffectRef,
  CapsuleRefs,
  CapsuleRunContext,
  CapsuleSpec,
  CaptureOptions,
  CapsulesService,
  EffectRecord,
  FailureManifest,
  InspectedRun,
  InternalCapsuleAdapter,
  OpenRunInput,
  RunIndexEntry,
  StandardSchemaV1,
  StepIdentity,
  StepManifest,
} from "./types.js";
import { digestBytes, stableHash } from "../internal/hash.js";
import { bodyToBytes } from "../internal/body.js";
import {
  DEFAULT_BRANCH,
  RUN_INDEX_PATH,
  RUN_JSON_PATH,
  attemptDirPath,
  commitMessageFor,
  failureCommitMessageFor,
  failurePath,
  effectRecordPath,
  filesBasePath,
  INIT_COMMIT_MESSAGE,
  inputHashPath,
  manifestPath,
  outputPath,
  runRepoName,
  stepDirName,
} from "../git/layout.js";
import { buildEffectRecord, effectDirectoryPath } from "../observability/effects.js";
import { appendIndexEntry, readRunIndex } from "../observability/run-index.js";

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
        ...(step.idempotencyKey !== undefined
          ? { idempotencyKey: step.idempotencyKey }
          : {}),
      });
    } catch (error) {
      await this.recordFailure(session, stepSession, recorder, error);
      throw error;
    }

    const outputBytes = serializeOutput(capsuleName, output, this.maxOutputBytes);
    const manifest = recorder.buildManifest(startedAt, output, {
      repo: session.repo,
      branch: session.branch,
      ...(parentAtStart !== undefined ? { parent: parentAtStart } : {}),
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
        ...(step.idempotencyKey !== undefined
          ? { idempotencyKey: step.idempotencyKey }
          : {}),
        ...(spec.dedupe !== undefined ? { dedupeKey: spec.dedupe.key } : {}),
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
        ...(committed.parent !== undefined ? { parent: committed.parent } : {}),
      },
      files: recorder.fileRefs(),
      effects: recorder.effectRefs(),
      effectCount: recorder.effectRefs().length,
      output,
      manifestPath: manifestPath(step.attemptDir),
      ...(committed.parent !== undefined
        ? { diff: { base: committed.parent, head: committed.commit } }
        : {}),
    };
  }

  async inspectRun(target: {
    workflowName: string;
    instanceId: string;
  }): Promise<InspectedRun> {
    const identityHash = await stableHash({
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
      ...(head !== undefined ? { head } : {}),
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
  const inputHash = await stableHash(input);
  const identityHash = await stableHash({ workflowName, instanceId });
  const stepDir = stepDirName(stepCount, stepName);
  const step: StepIdentity = {
    capsuleName: spec.name,
    capsuleId: spec.id ?? `${instanceId}:${slugify(stepName)}:${stepCount}`,
    stepName,
    stepCount,
    attempt,
    inputHash,
    ...(spec.idempotencyKey !== undefined
      ? { idempotencyKey: spec.idempotencyKey }
      : {}),
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

/** Buffers file writes and effect records for one step attempt. */
class AttemptRecorder {
  private readonly refs: Record<string, CapsuleFileRef> = {};
  private readonly exposedRefs: Record<string, CapsuleFileRef> = {};
  private readonly effectRecords: EffectRecord[] = [];
  private readonly effectRefsByPath: CapsuleEffectRef[] = [];
  private readonly kindCounts = new Map<string, number>();

  constructor(
    private readonly ctx: IdentityContext,
    private readonly stepSession: ArtifactStepSession,
    private readonly dedupeKey?: string,
    private readonly maxFileBytes?: number,
  ) {}

  async write(
    path: string,
    body: CapsuleFileBody,
    options?: CapsuleFileOptions,
  ): Promise<CapsuleFileRef> {
    const relPath = validateCapsulePath(path);
    const { bytes, mediaType } = await bodyToBytes(relPath, body);
    this.assertFileSize(relPath, bytes.byteLength);
    const repoPath = `${filesBasePath(this.ctx.step.attemptDir)}/${relPath}`;
    const ref: CapsuleFileRef = {
      path: repoPath,
      ...(options?.mediaType !== undefined
        ? { mediaType: options.mediaType }
        : mediaType !== undefined
          ? { mediaType }
          : {}),
      size: bytes.byteLength,
      digest: await digestBytes(bytes),
    };
    this.stepSession.stage(repoPath, bytes);
    this.refs[relPath] = ref;
    if (options?.exposeAs !== undefined) {
      this.exposedRefs[options.exposeAs] = ref;
    }
    return ref;
  }

  async recordEffect(
    kind: string,
    record: CapsuleEffectRecordInput = {},
  ): Promise<CapsuleEffectRef> {
    const kindSeq = (this.kindCounts.get(kind) ?? 0) + 1;
    this.kindCounts.set(kind, kindSeq);
    const effectDir = effectDirectoryPath(this.ctx.step, kind, kindSeq);
    const request = await this.writeEffectSnapshot(effectDir, "request", record.request);
    const response = await this.writeEffectSnapshot(effectDir, "response", record.response);
    const effectRef: CapsuleEffectRef = {
      kind,
      path: effectRecordPath(effectDir),
      seq: this.effectRecords.length + 1,
      ...(record.externalId !== undefined ? { externalId: record.externalId } : {}),
      ...(record.httpStatus !== undefined ? { httpStatus: record.httpStatus } : {}),
      ...(this.ctx.step.idempotencyKey !== undefined
        ? { idempotencyKey: this.ctx.step.idempotencyKey }
        : {}),
      ...(request !== undefined ? { request } : {}),
      ...(response !== undefined ? { response } : {}),
    };
    const effectRecord = buildEffectRecord({
      kind,
      record,
      ref: effectRef,
      seq: effectRef.seq,
      workflowName: this.ctx.workflowName,
      instanceId: this.ctx.instanceId,
      step: this.ctx.step,
      now: new Date(),
    });
    this.stepSession.stage(
      effectRef.path,
      encoder.encode(JSON.stringify(effectRecord, null, 2) + "\n"),
    );
    this.effectRecords.push(effectRecord);
    this.effectRefsByPath.push(effectRef);
    return effectRef;
  }

  private async writeEffectSnapshot(
    effectDir: string,
    defaultName: "request" | "response",
    snapshot: CapsuleEffectSnapshot | undefined,
  ): Promise<CapsuleFileRef | undefined> {
    if (snapshot === undefined) return undefined;
    const body = isSnapshotObject(snapshot) ? snapshot.body : snapshot;
    const snapshotPath = isSnapshotObject(snapshot)
      ? validateCapsulePath(snapshot.path ?? `${defaultName}.json`)
      : `${defaultName}.json`;
    const repoPath = `${effectDir}/${snapshotPath}`;
    const { bytes, mediaType } = await bodyToBytes(snapshotPath, body);
    this.assertFileSize(repoPath, bytes.byteLength);
    const ref: CapsuleFileRef = {
      path: repoPath,
      ...(isSnapshotObject(snapshot) && snapshot.mediaType !== undefined
        ? { mediaType: snapshot.mediaType }
        : mediaType !== undefined
          ? { mediaType }
          : {}),
      size: bytes.byteLength,
      digest: await digestBytes(bytes),
    };
    this.stepSession.stage(repoPath, bytes);
    return ref;
  }

  effects(): ReadonlyArray<EffectRecord> {
    return this.effectRecords;
  }

  effectRefs(): ReadonlyArray<CapsuleEffectRef> {
    return this.effectRefsByPath;
  }

  fileRefs(): Record<string, CapsuleFileRef> {
    return { ...this.exposedRefs };
  }

  private allFileRefs(): Record<string, CapsuleFileRef> {
    return { ...this.refs };
  }

  private assertFileSize(path: string, size: number): void {
    if (this.maxFileBytes === undefined || size <= this.maxFileBytes) return;
    throw new CapsuleError(
      "INVALID_CAPSULE_REQUEST",
      `Capsule file "${path}" is ${size} bytes; the configured limit is ` +
        `${this.maxFileBytes} bytes. File bodies are buffered before commit, so ` +
        `write a smaller file or record an external pointer. No commit was made.`,
    );
  }

  buildManifest(
    startedAt: Date,
    output: unknown,
    artifact: { repo: string; branch: string; parent?: string },
  ): StepManifest {
    const step = this.ctx.step;
    return {
      schemaVersion: 1,
      workflow: {
        name: this.ctx.workflowName,
        instanceId: this.ctx.instanceId,
      },
      step: { name: step.stepName, count: step.stepCount, attempt: step.attempt },
      capsule: {
        name: step.capsuleName,
        id: step.capsuleId,
        ...(step.idempotencyKey !== undefined
          ? { idempotencyKey: step.idempotencyKey }
          : {}),
        ...(this.dedupeKey !== undefined ? { dedupeKey: this.dedupeKey } : {}),
      },
      input: { hash: step.inputHash },
      artifact,
      files: this.allFileRefs(),
      exposedFiles: this.fileRefs(),
      effects: this.effectRecords,
      output,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
    };
  }

  buildFailureManifest(
    failure: { code: string; message: string; retryable: boolean },
    error: unknown,
  ): FailureManifest {
    const step = this.ctx.step;
    return {
      schemaVersion: 1,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: failure.message,
        retryable: failure.retryable,
      },
      workflow: {
        name: this.ctx.workflowName,
        instanceId: this.ctx.instanceId,
      },
      step: { name: step.stepName, count: step.stepCount, attempt: step.attempt },
      capsule: {
        name: step.capsuleName,
        id: step.capsuleId,
        ...(step.idempotencyKey !== undefined
          ? { idempotencyKey: step.idempotencyKey }
          : {}),
      },
      input: { hash: step.inputHash },
      files: this.allFileRefs(),
      effects: this.effectRecords,
      externalEffectPossible:
        this.effectRecords.length > 0 || step.idempotencyKey !== undefined,
      failedAt: new Date().toISOString(),
    };
  }
}

function isSnapshotObject(
  snapshot: CapsuleEffectSnapshot,
): snapshot is CapsuleEffectSnapshotOptions {
  return (
    snapshot !== null &&
    typeof snapshot === "object" &&
    !(snapshot instanceof Uint8Array) &&
    !(snapshot instanceof ArrayBuffer) &&
    !(typeof Blob !== "undefined" && snapshot instanceof Blob) &&
    !(typeof ReadableStream !== "undefined" && snapshot instanceof ReadableStream) &&
    "body" in snapshot
  );
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
      ...(resolved.manifest.capsule.idempotencyKey !== undefined
        ? { idempotencyKey: resolved.manifest.capsule.idempotencyKey }
        : {}),
      ...(resolved.manifest.capsule.dedupeKey !== undefined
        ? { dedupeKey: resolved.manifest.capsule.dedupeKey }
        : {}),
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
      ...(resolved.parent !== undefined ? { parent: resolved.parent } : {}),
    },
    files: { ...(resolved.manifest.exposedFiles ?? {}) },
    effects: resolved.manifest.effects.map((effect) => ({
      kind: effect.kind,
      path: effect.path,
      seq: effect.seq,
      ...(effect.externalId !== undefined ? { externalId: effect.externalId } : {}),
      ...(effect.httpStatus !== undefined ? { httpStatus: effect.httpStatus } : {}),
      ...(effect.idempotencyKey !== undefined
        ? { idempotencyKey: effect.idempotencyKey }
        : {}),
      ...(effect.request !== undefined ? { request: effect.request } : {}),
      ...(effect.response !== undefined ? { response: effect.response } : {}),
    })),
    output: resolved.manifest.output as Output,
    effectCount: resolved.manifest.effects.length,
    manifestPath: manifestPath(
      attemptDirPath(
        stepDirName(resolved.manifest.step.count, resolved.manifest.step.name),
        resolved.manifest.step.attempt,
      ),
    ),
    ...(resolved.parent !== undefined
      ? { diff: { base: resolved.parent, head: resolved.commit } }
      : {}),
  };
}

function optionalLimits(options: CreateCapsulesOptions): {
  readonly maxOutputBytes?: number;
  readonly maxFileBytes?: number;
} {
  return {
    ...(options.maxOutputBytes !== undefined
      ? { maxOutputBytes: options.maxOutputBytes }
      : {}),
    ...(options.maxFileBytes !== undefined ? { maxFileBytes: options.maxFileBytes } : {}),
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
