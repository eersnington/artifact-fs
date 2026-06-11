import {
  cloudflareCallStore,
  type ArtifactsBindingLike,
  type CloudflareRepositoryStoreOptions,
} from "./repositories/cloudflare-artifacts.js";
import type { CloudflareAdapter, InternalCapsuleAdapter } from "./core/types.js";

/**
 * Create the Cloudflare Artifacts adapter for production Workers/Workflows.
 *
 * Artifacts stores compact call-history JSON records. The binding manages
 * repositories and tokens, while this adapter uses a Worker-compatible Git path
 * for commits.
 */
export function cloudflare(
  binding: ArtifactsBindingLike,
  options?: CloudflareRepositoryStoreOptions,
): CloudflareAdapter {
  return {
    kind: "cloudflare",
    store: cloudflareCallStore(binding, options),
  } as InternalCapsuleAdapter as CloudflareAdapter;
}

export type { ArtifactsBindingLike, CloudflareRepositoryStoreOptions };
