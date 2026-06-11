import { slugify } from "./validation.js";

/** Canonical run-repo layout for external call history records. */

export const RUN_JSON_PATH = ".capsule/run.json";
export const DEFAULT_BRANCH = "main";
export const INIT_COMMIT_MESSAGE = "capsules: init workflow run";

const MAX_REPO_NAME_LENGTH = 100;

export function callDirPath(keyHash: string): string {
  return `.capsule/by-key/${keyHashToPathSegment(keyHash)}`;
}

export function callRequestPath(callDir: string): string {
  return `${callDir}/request.json`;
}

export function callStartedPath(callDir: string): string {
  return `${callDir}/started.json`;
}

export function callCommittedPath(callDir: string): string {
  return `${callDir}/committed.json`;
}

export function callSummaryPath(callDir: string): string {
  return `${callDir}/summary.json`;
}

export function callReconciledPath(callDir: string): string {
  return `${callDir}/reconciled.json`;
}

export function callAttemptStartedPath(callDir: string, attempt: number): string {
  return `${callDir}/attempts/${String(attempt).padStart(3, "0")}-started.json`;
}

export function callAttemptErrorPath(callDir: string, attempt: number): string {
  return `${callDir}/attempts/${String(attempt).padStart(3, "0")}-error.json`;
}

/**
 * Deterministic run-repo name from run identity. Sanitized to the
 * `[a-zA-Z0-9_][a-zA-Z0-9-_]*` charset and bounded.
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

export function commitMessageForStarted(callName: string, attempt: number): string {
  return `capsules: ${callName} attempt ${attempt} started`;
}

export function commitMessageForCommitted(callName: string, attempt: number): string {
  return `capsules: ${callName} attempt ${attempt} committed`;
}

export function commitMessageForReconciled(callName: string, attempt: number): string {
  return `capsules: ${callName} attempt ${attempt} reconciled`;
}

export function commitMessageForError(callName: string, attempt: number): string {
  return `capsules: ${callName} attempt ${attempt} error`;
}

function keyHashToPathSegment(keyHash: string): string {
  return keyHash.startsWith("sha256:") ? keyHash.slice("sha256:".length) : slugify(keyHash);
}

function sanitizeRepoSegment(text: string): string {
  const sanitized = text
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^[-]+|[-]+$/g, "");
  return sanitized.length > 0 ? sanitized : "run";
}
