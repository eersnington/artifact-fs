import { httpStore, type HttpStoreOptions } from "./artifacts/hosted.js";
import { createTreeBackend } from "./artifacts/tree-backend.js";
import type { InternalCapsuleAdapter, RemoteAdapter } from "./core/types.js";

export type RemoteOptions = HttpStoreOptions;

/**
 * Create a generic remote HTTP adapter for a local bridge, self-hosted writer,
 * or hosted artifact service.
 *
 * The remote protocol sends base64 file maps over JSON and buffers file bodies
 * before commit. It is intended for small/medium inspectable artifact trees,
 * not streaming blob uploads or huge directories.
 */
export function remote(options: RemoteOptions): RemoteAdapter {
  return {
    kind: "remote",
    backend: createTreeBackend(httpStore("remote", options)),
  } as InternalCapsuleAdapter as RemoteAdapter;
}
