import type {
  CapsuleEffectDetails,
  EffectRecord,
  StepIdentity,
} from "../core/types.js";
import { safeEffectKind } from "../core/validation.js";
import { effectPath } from "../git/layout.js";

/**
 * Compute the repo-absolute effect file path for the nth occurrence of an
 * effect kind within one attempt. The first occurrence keeps the clean
 * `<safe-kind>.json` name; repeats get `-2`, `-3`, ... suffixes.
 */
export function effectFilePath(
  step: StepIdentity,
  kind: string,
  kindSeq: number,
): string {
  const safeKind = safeEffectKind(kind);
  const stem = kindSeq <= 1 ? safeKind : `${safeKind}-${kindSeq}`;
  return effectPath(step.attemptDir, stem);
}

/**
 * Build the audit record for an external side effect that already happened.
 * Capsule supplies workflow/step/attempt/idempotency metadata; the caller
 * supplies only concrete provider facts. No status/outcome summary belongs
 * here: step success is represented by the commit or failure manifest.
 */
export function buildEffectRecord(input: {
  kind: string;
  details: CapsuleEffectDetails;
  path: string;
  seq: number;
  workflowName: string;
  instanceId: string;
  step: StepIdentity;
  now: Date;
}): EffectRecord {
  return {
    kind: input.kind,
    path: input.path,
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
    details: input.details,
  };
}
