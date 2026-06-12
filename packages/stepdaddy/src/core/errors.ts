export type StepdaddyErrorCode =
  | "INVALID_EXTERNAL_CALL"
  | "SIDE_EFFECT_CONFLICT"
  | "SIDE_EFFECT_AMBIGUOUS"
  | "SIDE_EFFECT_STORAGE_FAILED"
  | "SIDE_EFFECT_RECONCILE_FAILED";

const RETRYABLE: Record<StepdaddyErrorCode, boolean> = {
  INVALID_EXTERNAL_CALL: false,
  SIDE_EFFECT_CONFLICT: false,
  SIDE_EFFECT_AMBIGUOUS: false,
  SIDE_EFFECT_STORAGE_FAILED: true,
  SIDE_EFFECT_RECONCILE_FAILED: true,
};

/** Tagged error for failures raised by Stepdaddy itself. */
export class StepdaddyError extends Error {
  readonly code: StepdaddyErrorCode;
  readonly retryable: boolean;
  override readonly cause?: unknown;

  constructor(
    code: StepdaddyErrorCode,
    message: string,
    options?: { cause?: unknown; retryable?: boolean },
  ) {
    super(message);
    this.name = "StepdaddyError";
    this.code = code;
    this.retryable = options?.retryable ?? RETRYABLE[code];
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

export function invalidExternalCall(message: string): StepdaddyError {
  return new StepdaddyError("INVALID_EXTERNAL_CALL", message);
}

export function sideEffectConflict(message: string): StepdaddyError {
  return new StepdaddyError("SIDE_EFFECT_CONFLICT", message);
}

export function sideEffectAmbiguous(message: string): StepdaddyError {
  return new StepdaddyError("SIDE_EFFECT_AMBIGUOUS", message);
}

export function storageFailed(
  message: string,
  cause?: unknown,
  options?: { readonly retryable?: boolean },
): StepdaddyError {
  return new StepdaddyError("SIDE_EFFECT_STORAGE_FAILED", message, {
    ...(cause !== undefined ? { cause } : {}),
    ...(options?.retryable !== undefined ? { retryable: options.retryable } : {}),
  });
}

export function reconcileFailed(message: string, cause?: unknown): StepdaddyError {
  return new StepdaddyError("SIDE_EFFECT_RECONCILE_FAILED", message, {
    ...(cause !== undefined ? { cause } : {}),
  });
}
