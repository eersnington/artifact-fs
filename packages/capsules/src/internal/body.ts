import { invalidRequest } from "../core/errors.js";
import type { CapsuleFileBody } from "../core/types.js";

const encoder = new TextEncoder();

/**
 * Convert a `files.write()` body into bytes plus an inferred media type.
 *
 * MVP caveat: stream bodies are buffered in memory before committing because
 * the in-Worker git path needs the whole tree. The hosted/bridge protocol is
 * the path to true streaming writes.
 */
export async function bodyToBytes(
  path: string,
  body: CapsuleFileBody,
): Promise<{ bytes: Uint8Array; mediaType?: string }> {
  if (typeof body === "string") {
    return { bytes: encoder.encode(body), ...inferred(path) };
  }
  if (body instanceof Uint8Array) {
    return { bytes: body, ...inferred(path) };
  }
  if (body instanceof ArrayBuffer) {
    return { bytes: new Uint8Array(body), ...inferred(path) };
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    const mediaType = body.type !== "" ? { mediaType: body.type } : inferred(path);
    return { bytes: new Uint8Array(await body.arrayBuffer()), ...mediaType };
  }
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
    return { bytes: await readAll(body), ...inferred(path) };
  }
  if (body === undefined || typeof body === "function") {
    throw invalidRequest(
      `files.write("${path}") received a body that cannot be serialized. ` +
        `Pass a JSON-like object, string, Uint8Array, ArrayBuffer, Blob, or ReadableStream.`,
    );
  }
  // JSON-like value (object, array, number, boolean, null).
  return {
    bytes: encoder.encode(JSON.stringify(body, null, 2) + "\n"),
    mediaType: "application/json",
  };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
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

function inferred(path: string): { mediaType?: string } {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return {};
  const ext = path.slice(dot + 1).toLowerCase();
  const mediaType = MEDIA_TYPES[ext];
  return mediaType !== undefined ? { mediaType } : {};
}
