import { remoteHttpStore, type RemoteHttpStoreOptions } from "./artifacts/remote-http.js";
import { createRepositoryBackend } from "./artifacts/tree-backend.js";
import type { InternalCapsuleAdapter, RemoteAdapter } from "./core/types.js";

export type RemoteOptions = RemoteHttpStoreOptions;

/**
 * Create a generic remote HTTP adapter for a self-hosted writer or hosted
 * artifact service.
 *
 * The remote protocol sends multipart binary file uploads with JSON metadata
 * and buffers file bodies before commit. It is intended for small/medium
 * inspectable artifact trees, not streaming blob uploads or huge directories.
 */
export function remote(options: RemoteOptions): RemoteAdapter {
  return {
    kind: "remote",
    backend: createRepositoryBackend(remoteHttpStore(options)),
  } as InternalCapsuleAdapter as RemoteAdapter;
}
