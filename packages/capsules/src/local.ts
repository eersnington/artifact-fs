import { createTreeBackend } from "./artifacts/tree-backend.js";
import { localNodeStore } from "./artifacts/local-node.js";
import type { InternalCapsuleAdapter, LocalAdapter } from "./core/types.js";

export type LocalOptions = {
  /** Directory that holds one persistent Git repo per Workflow run. */
  readonly root: string;
  /** Commit author. Defaults to workflow-capsules. */
  readonly author?: { readonly name: string; readonly email: string };
};

/**
 * Create a persistent local Node adapter backed by Git repos under `root`.
 *
 * Use `local()` for development and integration tests where artifacts should
 * survive process restarts and be inspectable with normal Git tooling. This is
 * Node-only and uses native local filesystem/Git behavior underneath; use
 * `memory()` for pure ephemeral unit tests.
 */
export function local(options: LocalOptions): LocalAdapter {
  return {
    kind: "local",
    backend: createTreeBackend(
      localNodeStore({
        mountRoot: options.root,
        ...(options.author !== undefined ? { author: options.author } : {}),
      }),
    ),
  } as InternalCapsuleAdapter as LocalAdapter;
}
