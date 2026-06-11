import { memoryCallStore } from "./repositories/memory.js";
import type { InternalCapsuleAdapter, MemoryAdapter } from "./core/types.js";

/**
 * Create an ephemeral in-process adapter for unit tests and deterministic
 * examples.
 *
 * `memory()` keeps committed call-history repos only for the lifetime of this
 * JavaScript process. It does not persist to disk; use `local()` when you need
 * to inspect records after restart.
 */
export function memory(): MemoryAdapter {
  return {
    kind: "memory",
    store: memoryCallStore(),
  } as InternalCapsuleAdapter as MemoryAdapter;
}
