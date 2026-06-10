import type { CapsuleFailure } from "./types.js";

export type CapsuleErrorCode =
  | "INVALID_CAPSULE_REQUEST"
  | "CAPSULE_CONFLICT"
  | "BACKEND_UNAVAILABLE"
  | "BACKEND_WRITE_FAILED"
  | "OPERATION_FAILED";

const RETRYABLE: Record<CapsuleErrorCode, boolean> = {
  INVALID_CAPSULE_REQUEST: false,
  CAPSULE_CONFLICT: false,
  BACKEND_UNAVAILABLE: true,
  BACKEND_WRITE_FAILED: true,
  OPERATION_FAILED: true,
};

/**
 * Tagged error for everything Capsule raises itself. `retryable` mirrors how
 * the failure should interact with `step.do()` retries: validation and
 * conflict errors will fail every attempt identically, so callers should
 * treat them as terminal (or convert them to `NonRetryableError`).
 */
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

export function invalidRequest(message: string): CapsuleError {
  return new CapsuleError("INVALID_CAPSULE_REQUEST", message);
}

/**
 * Convert any thrown value into a structured CapsuleFailure for failure
 * manifests. Errors named `NonRetryableError` (Cloudflare's terminal error)
 * and non-retryable CapsuleErrors are marked non-retryable.
 */
export function toCapsuleFailure(error: unknown): CapsuleFailure {
  if (error instanceof CapsuleError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      cause: error.cause,
    };
  }
  if (error instanceof Error) {
    return {
      code: "OPERATION_FAILED",
      message: error.message,
      retryable: error.name !== "NonRetryableError",
      cause: error,
    };
  }
  return {
    code: "OPERATION_FAILED",
    message: String(error),
    retryable: true,
    cause: error,
  };
}
