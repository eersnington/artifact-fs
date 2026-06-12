import { remoteHttpStore, type RemoteHttpStoreOptions } from "./repositories/remote-http.js";
import type { InternalStepdaddyAdapter, RemoteAdapter } from "./core/types.js";

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
    store: remoteHttpStore(options),
  } as InternalStepdaddyAdapter as RemoteAdapter;
}
