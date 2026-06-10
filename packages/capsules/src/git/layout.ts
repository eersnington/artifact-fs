import { slugify } from "../core/validation.js";
import type { StepIdentity } from "../core/types.js";

/**
 * Canonical run-repo layout. Every artifact layer writes the same tree:
 *
 *   .capsule/run.json
 *   .capsule/index.json
 *   steps/<NNN>-<step-slug>/attempts/<n>/manifest.json
 *   steps/<NNN>-<step-slug>/attempts/<n>/failure.json        (failed attempts)
 *   steps/<NNN>-<step-slug>/attempts/<n>/input.hash.json
 *   steps/<NNN>-<step-slug>/attempts/<n>/output.json
 *   steps/<NNN>-<step-slug>/attempts/<n>/effects/<safe-kind>.json
 *   steps/<NNN>-<step-slug>/attempts/<n>/files/...
 */

export const RUN_JSON_PATH = ".capsule/run.json";
export const RUN_INDEX_PATH = ".capsule/index.json";
export const DEFAULT_BRANCH = "main";

const MAX_REPO_NAME_LENGTH = 100;

export function stepDirName(stepCount: number, stepName: string): string {
  return `${String(stepCount).padStart(3, "0")}-${slugify(stepName)}`;
}

export function attemptDirPath(stepDir: string, attempt: number): string {
  return `steps/${stepDir}/attempts/${attempt}`;
}

export function manifestPath(attemptDir: string): string {
  return `${attemptDir}/manifest.json`;
}

export function failurePath(attemptDir: string): string {
  return `${attemptDir}/failure.json`;
}

export function inputHashPath(attemptDir: string): string {
  return `${attemptDir}/input.hash.json`;
}

export function outputPath(attemptDir: string): string {
  return `${attemptDir}/output.json`;
}

export function effectPath(attemptDir: string, safeKind: string): string {
  return `${attemptDir}/effects/${safeKind}.json`;
}

export function filesBasePath(attemptDir: string): string {
  return `${attemptDir}/files`;
}

/**
 * Deterministic run-repo name from run identity. Sanitized to the
 * `[a-zA-Z0-9_][a-zA-Z0-9-_]*` charset and bounded: when the combined name
 * would exceed the limit, both parts are truncated and an 8-char hash of the
 * full identity is appended so distinct runs can never collide.
 */
export function runRepoName(
  workflowName: string,
  instanceId: string,
  identityHashHex: string,
): string {
  const wf = sanitizeRepoSegment(workflowName);
  const id = sanitizeRepoSegment(instanceId);
  const full = `capsule-${wf}-${id}`;
  if (full.length <= MAX_REPO_NAME_LENGTH) {
    return full;
  }
  const suffix = identityHashHex.slice(0, 8);
  const budget = MAX_REPO_NAME_LENGTH - "capsule-".length - suffix.length - 2;
  const wfBudget = Math.ceil(budget / 2);
  const idBudget = budget - wfBudget;
  return `capsule-${wf.slice(0, wfBudget)}-${id.slice(0, idBudget)}-${suffix}`;
}

function sanitizeRepoSegment(text: string): string {
  const sanitized = text
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^[-]+|[-]+$/g, "");
  return sanitized.length > 0 ? sanitized : "run";
}

export function commitMessageFor(step: StepIdentity): string {
  return `capsule: ${step.capsuleName} step ${step.stepDir} attempt ${step.attempt}`;
}

export function failureCommitMessageFor(step: StepIdentity): string {
  return `capsule: ${step.capsuleName} step ${step.stepDir} attempt ${step.attempt} failed`;
}

export const INIT_COMMIT_MESSAGE = "capsule: init workflow run";
