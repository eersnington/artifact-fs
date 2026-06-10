import { createTreeBackend } from "./artifacts/tree-backend.js";
import {
  workersStore,
  type ArtifactsBindingLike,
  type WorkersStoreOptions,
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
  options?: WorkersStoreOptions,
): CloudflareAdapter {
  return {
    kind: "cloudflare",
    backend: createTreeBackend(workersStore(binding, options)),
  } as InternalCapsuleAdapter as CloudflareAdapter;
}

export type { ArtifactsBindingLike, WorkersStoreOptions };
