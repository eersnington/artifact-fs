import { CapsuleError } from "./errors.js";
import { readCapsuleFileBody } from "./file-content.js";
import { digestFileContent } from "./content-digest.js";
import { validateCapsulePath } from "./validation.js";
import {
  effectRecordPath,
  filesBasePath,
} from "./repo-layout.js";
import { buildEffectRecord, effectDirectoryPath } from "./effects.js";
import type {
  ArtifactStepSession,
  CapsuleEffectRecordInput,
  CapsuleEffectRef,
  CapsuleEffectSnapshot,
  CapsuleEffectSnapshotOptions,
  CapsuleFileBody,
  CapsuleFileOptions,
  CapsuleFileRef,
  EffectRecord,
  FailureManifest,
  StepIdentity,
  StepManifest,
} from "./types.js";

const encoder = new TextEncoder();

export type AttemptRecorderContext = {
  readonly workflowName: string;
  readonly instanceId: string;
  readonly step: StepIdentity;
};

/** Buffers file writes and effect records for one step attempt. */
export class AttemptRecorder {
  private readonly refs: Record<string, CapsuleFileRef> = {};
  private readonly exposedRefs: Record<string, CapsuleFileRef> = {};
  private readonly effectRecords: EffectRecord[] = [];
  private readonly effectRefsByPath: CapsuleEffectRef[] = [];
  private readonly kindCounts = new Map<string, number>();

  constructor(
    private readonly ctx: AttemptRecorderContext,
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
    const { bytes, mediaType } = await readCapsuleFileBody(relPath, body);
    this.assertFileSize(relPath, bytes.byteLength);
    const repoPath = `${filesBasePath(this.ctx.step.attemptDir)}/${relPath}`;
    const refMediaType = options?.mediaType ?? mediaType;
    const ref: CapsuleFileRef = {
      path: repoPath,
      ...(refMediaType !== undefined && { mediaType: refMediaType }),
      size: bytes.byteLength,
      digest: await digestFileContent(bytes),
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
      ...(record.externalId !== undefined && { externalId: record.externalId }),
      ...(record.httpStatus !== undefined && { httpStatus: record.httpStatus }),
      ...(this.ctx.step.idempotencyKey !== undefined && {
        idempotencyKey: this.ctx.step.idempotencyKey,
      }),
      ...(request !== undefined && { request }),
      ...(response !== undefined && { response }),
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

  effects(): ReadonlyArray<EffectRecord> {
    return this.effectRecords;
  }

  effectRefs(): ReadonlyArray<CapsuleEffectRef> {
    return this.effectRefsByPath;
  }

  fileRefs(): Record<string, CapsuleFileRef> {
    return { ...this.exposedRefs };
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
        ...(step.idempotencyKey !== undefined && {
          idempotencyKey: step.idempotencyKey,
        }),
        ...(this.dedupeKey !== undefined && { dedupeKey: this.dedupeKey }),
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
        ...(step.idempotencyKey !== undefined && {
          idempotencyKey: step.idempotencyKey,
        }),
      },
      input: { hash: step.inputHash },
      files: this.allFileRefs(),
      effects: this.effectRecords,
      externalEffectPossible:
        this.effectRecords.length > 0 || step.idempotencyKey !== undefined,
      failedAt: new Date().toISOString(),
    };
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
    const { bytes, mediaType } = await readCapsuleFileBody(snapshotPath, body);
    this.assertFileSize(repoPath, bytes.byteLength);
    const refMediaType = isSnapshotObject(snapshot)
      ? snapshot.mediaType ?? mediaType
      : mediaType;
    const ref: CapsuleFileRef = {
      path: repoPath,
      ...(refMediaType !== undefined && { mediaType: refMediaType }),
      size: bytes.byteLength,
      digest: await digestFileContent(bytes),
    };
    this.stepSession.stage(repoPath, bytes);
    return ref;
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
