/**
 * Generic deep redaction for request/response payloads written into artifact
 * files. Capsule never writes secrets on its own; this helper exists so user
 * code has an easy default before calling `files.write()`.
 */

const DEFAULT_SENSITIVE_KEYS = [
  "authorization",
  "cookie",
  "set-cookie",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
  "secret",
  "password",
  "api_key",
  "apikey",
  "private_key",
  "session",
];

export type RedactOptions = {
  /** Additional key names (case-insensitive) to redact. */
  readonly keys?: ReadonlyArray<string>;
  /** Replacement value. Defaults to "[REDACTED]". */
  readonly replacement?: string;
};

export function redact<T>(value: T, options?: RedactOptions): T {
  const keys = new Set(
    [...DEFAULT_SENSITIVE_KEYS, ...(options?.keys ?? [])].map((k) =>
      k.toLowerCase(),
    ),
  );
  const replacement = options?.replacement ?? "[REDACTED]";
  return redactValue(value, keys, replacement) as T;
}

function redactValue(
  value: unknown,
  keys: ReadonlySet<string>,
  replacement: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, keys, replacement));
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      out[key] = keys.has(key.toLowerCase())
        ? replacement
        : redactValue(item, keys, replacement);
    }
    return out;
  }
  return value;
}
