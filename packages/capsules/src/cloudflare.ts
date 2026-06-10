import { createRepositoryBackend } from "./artifacts/tree-backend.js";
import {
  cloudflareRepositoryStore,
  type ArtifactsBindingLike,
  type CloudflareRepositoryStoreOptions,
} from "./artifacts/workers.js";
import type { CloudflareAdapter, InternalCapsuleAdapter } from "./core/types.js";

/**
 * Create the Cloudflare Artifacts adapter for production Workers/Workflows.
 *
 * The Cloudflare Artifacts binding manages repositories and tokens but does
 * not directly write file trees. This adapter uses the binding for repo/token
 * control-plane operations and a Worker-compatible Git write path for commits.
 * File bodies are buffered before commit; avoid very large files or directories
 * and record compact external pointers instead.
 */
export function cloudflare(
  binding: ArtifactsBindingLike,
  options?: CloudflareRepositoryStoreOptions,
): CloudflareAdapter {
  return {
    kind: "cloudflare",
    backend: createRepositoryBackend(cloudflareRepositoryStore(binding, options)),
  } as InternalCapsuleAdapter as CloudflareAdapter;
}

export type { ArtifactsBindingLike, CloudflareRepositoryStoreOptions };
