/**
 * Hashing helpers built on Web Crypto so they run in Workers, Node 18+, and
 * browsers without imports.
 */

const encoder = new TextEncoder();

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer;
  const digest = await crypto.subtle.digest("SHA-256", buffer as ArrayBuffer);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function digestBytes(bytes: Uint8Array): Promise<string> {
  return `sha256:${await sha256Hex(bytes)}`;
}

/**
 * Stable content hash of a JSON-like value: object keys are sorted at every
 * depth so logically-equal inputs hash identically regardless of key order.
 * `undefined` object properties are omitted, matching JSON.stringify.
 */
export async function stableHash(value: unknown): Promise<string> {
  return digestBytes(encoder.encode(canonicalJson(value)));
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) {
        sorted[key] = sortValue(record[key]);
      }
    }
    return sorted;
  }
  return value;
}
