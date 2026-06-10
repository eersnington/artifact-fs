import { invalidRequest } from "./errors.js";
import type { CapsuleFileBody } from "./types.js";

const encoder = new TextEncoder();

export type CapsuleFileContent = {
  readonly bytes: Uint8Array;
  readonly mediaType?: string;
};

export async function readCapsuleFileBody(
  path: string,
  body: CapsuleFileBody,
): Promise<CapsuleFileContent> {
  if (typeof body === "string") {
    return withInferredMediaType(path, encoder.encode(body));
  }
  if (body instanceof Uint8Array) {
    return withInferredMediaType(path, body);
  }
  if (body instanceof ArrayBuffer) {
    return withInferredMediaType(path, new Uint8Array(body));
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    const bytes = new Uint8Array(await body.arrayBuffer());
    if (body.type !== "") return { bytes, mediaType: body.type };
    return withInferredMediaType(path, bytes);
  }
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
    return withInferredMediaType(path, await readStreamBody(body));
  }
  if (body === undefined || typeof body === "function") {
    throw invalidRequest(
      `files.write("${path}") received a body that cannot be serialized. ` +
        `Pass a JSON-like object, string, Uint8Array, ArrayBuffer, Blob, or ReadableStream.`,
    );
  }
  return {
    bytes: encoder.encode(JSON.stringify(body, null, 2) + "\n"),
    mediaType: "application/json",
  };
}

function withInferredMediaType(path: string, bytes: Uint8Array): CapsuleFileContent {
  const mediaType = inferMediaType(path);
  return mediaType === undefined ? { bytes } : { bytes, mediaType };
}

async function readStreamBody(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalBytes += value.byteLength;
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

const MEDIA_TYPES: Record<string, string> = {
  json: "application/json",
  md: "text/markdown",
  txt: "text/plain",
  html: "text/html",
  csv: "text/csv",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
  gz: "application/gzip",
  tar: "application/x-tar",
  zip: "application/zip",
  wasm: "application/wasm",
};

function inferMediaType(path: string): string | undefined {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return undefined;
  return MEDIA_TYPES[path.slice(dot + 1).toLowerCase()];
}
