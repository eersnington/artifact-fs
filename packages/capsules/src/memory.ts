import { createRepositoryBackend } from "./repositories/backend.js";
import { memoryRepositoryStore } from "./repositories/memory.js";
import type { InternalCapsuleAdapter, MemoryAdapter } from "./core/types.js";

/**
 * Create an ephemeral in-process adapter for unit tests and deterministic
 * examples.
 *
 * `memory()` keeps committed capsule repos only for the lifetime of this
 * JavaScript process. It does not persist to disk and should not be used as a
 * local development store when you need to inspect artifacts after restart; use
 * the `local()` adapter for that.
 */
export function memory(): MemoryAdapter {
  return {
    kind: "memory",
    backend: createRepositoryBackend(memoryRepositoryStore()),
  } as InternalCapsuleAdapter as MemoryAdapter;
}
