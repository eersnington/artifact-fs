import type {
  CapsuleEffectRef,
  CapsuleEffectRecordInput,
  EffectRecord,
  StepIdentity,
} from "../core/types.js";
import { safeEffectKind } from "../core/validation.js";
import { effectDirPath } from "../git/layout.js";

/**
 * Compute the repo-absolute effect directory for the nth occurrence of an
 * effect kind within one attempt. The first occurrence keeps the clean
 * `<safe-kind>` name; repeats get `-2`, `-3`, ... suffixes.
 */
export function effectDirectoryPath(
  step: StepIdentity,
  kind: string,
  kindSeq: number,
): string {
  const safeKind = safeEffectKind(kind);
  const stem = kindSeq <= 1 ? safeKind : `${safeKind}-${kindSeq}`;
  return effectDirPath(step.attemptDir, stem);
}

/**
 * Build the audit record for an external side effect that already happened.
 * Capsule supplies workflow/step/attempt/idempotency metadata; the caller
 * supplies only concrete provider facts. No status/outcome summary belongs
 * here: step success is represented by the commit or failure manifest.
 */
export function buildEffectRecord(input: {
  kind: string;
  record: CapsuleEffectRecordInput;
  ref: CapsuleEffectRef;
  seq: number;
  workflowName: string;
  instanceId: string;
  step: StepIdentity;
  now: Date;
}): EffectRecord {
  return {
    kind: input.kind,
    path: input.ref.path,
    seq: input.seq,
    recordedAt: input.now.toISOString(),
    workflow: { name: input.workflowName, instanceId: input.instanceId },
    step: {
      name: input.step.stepName,
      count: input.step.stepCount,
      attempt: input.step.attempt,
    },
    capsule: { name: input.step.capsuleName, id: input.step.capsuleId },
    ...(input.step.idempotencyKey !== undefined
      ? { idempotencyKey: input.step.idempotencyKey }
      : {}),
    ...(input.record.externalId !== undefined
      ? { externalId: input.record.externalId }
      : {}),
    ...(input.record.httpStatus !== undefined
      ? { httpStatus: input.record.httpStatus }
      : {}),
    ...(input.ref.request !== undefined ? { request: input.ref.request } : {}),
    ...(input.ref.response !== undefined ? { response: input.ref.response } : {}),
    ...(input.record.metadata !== undefined ? { metadata: input.record.metadata } : {}),
  };
}
