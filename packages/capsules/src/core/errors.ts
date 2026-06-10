export type CapsuleErrorCode =
  | "INVALID_EXTERNAL_CALL"
  | "SIDE_EFFECT_CONFLICT"
  | "SIDE_EFFECT_AMBIGUOUS"
  | "SIDE_EFFECT_STORAGE_FAILED"
  | "SIDE_EFFECT_RECONCILE_FAILED";

const RETRYABLE: Record<CapsuleErrorCode, boolean> = {
  INVALID_EXTERNAL_CALL: false,
  SIDE_EFFECT_CONFLICT: false,
  SIDE_EFFECT_AMBIGUOUS: false,
  SIDE_EFFECT_STORAGE_FAILED: true,
  SIDE_EFFECT_RECONCILE_FAILED: true,
};

/** Tagged error for failures raised by Capsules itself. */
export class CapsuleError extends Error {
  readonly code: CapsuleErrorCode;
  readonly retryable: boolean;
  override readonly cause?: unknown;

  constructor(
    code: CapsuleErrorCode,
    message: string,
    options?: { cause?: unknown; retryable?: boolean },
  ) {
    super(message);
    this.name = "CapsuleError";
    this.code = code;
    this.retryable = options?.retryable ?? RETRYABLE[code];
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

export function invalidExternalCall(message: string): CapsuleError {
  return new CapsuleError("INVALID_EXTERNAL_CALL", message);
}

export function sideEffectConflict(message: string): CapsuleError {
  return new CapsuleError("SIDE_EFFECT_CONFLICT", message);
}

export function sideEffectAmbiguous(message: string): CapsuleError {
  return new CapsuleError("SIDE_EFFECT_AMBIGUOUS", message);
}

export function storageFailed(
  message: string,
  cause?: unknown,
  options?: { readonly retryable?: boolean },
): CapsuleError {
  return new CapsuleError("SIDE_EFFECT_STORAGE_FAILED", message, {
    ...(cause !== undefined ? { cause } : {}),
    ...(options?.retryable !== undefined ? { retryable: options.retryable } : {}),
  });
}

export function reconcileFailed(message: string, cause?: unknown): CapsuleError {
  return new CapsuleError("SIDE_EFFECT_RECONCILE_FAILED", message, {
    ...(cause !== undefined ? { cause } : {}),
  });
}
