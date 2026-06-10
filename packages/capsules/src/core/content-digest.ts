const encoder = new TextEncoder();

export async function digestFileContent(bytes: Uint8Array): Promise<string> {
  return `sha256:${await sha256Hex(bytes)}`;
}

export async function hashCapsuleInput(input: unknown): Promise<string> {
  return digestCanonicalJson(input);
}

export async function hashExternalRequest(input: unknown): Promise<string> {
  return digestCanonicalJson(input);
}

export async function hashExternalCallKey(input: string): Promise<string> {
  return digestCanonicalJson({ key: input });
}

export async function hashWorkflowRun(input: {
  readonly workflowName: string;
  readonly instanceId: string;
}): Promise<string> {
  return digestCanonicalJson(input);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer;
  const digest = await crypto.subtle.digest("SHA-256", buffer as ArrayBuffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function digestCanonicalJson(value: unknown): Promise<string> {
  return digestFileContent(encoder.encode(canonicalJson(value)));
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) {
        sorted[key] = sortJsonValue(record[key]);
      }
    }
    return sorted;
  }
  return value;
}
