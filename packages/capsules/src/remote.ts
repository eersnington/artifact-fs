import { remoteHttpStore, type RemoteHttpStoreOptions } from "./repositories/remote-http.js";
import { createRepositoryBackend } from "./repositories/backend.js";
import type { InternalCapsuleAdapter, RemoteAdapter } from "./core/types.js";

export type RemoteOptions = RemoteHttpStoreOptions;

/**
 * Create a generic remote HTTP adapter for a self-hosted writer or hosted
 * call-history service.
 *
 * The remote protocol sends multipart JSON record uploads with metadata and is
 * intended for compact side-effect records, not streaming blob uploads.
 */
export function remote(options: RemoteOptions): RemoteAdapter {
  return {
    kind: "remote",
    backend: createRepositoryBackend(remoteHttpStore(options)),
  } as InternalCapsuleAdapter as RemoteAdapter;
}
