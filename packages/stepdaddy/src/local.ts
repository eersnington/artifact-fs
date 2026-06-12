import { localCallStore } from "./repositories/local-node.js";
import type { InternalStepdaddyAdapter, LocalAdapter } from "./core/types.js";

export type LocalOptions = {
  /** Directory that holds one persistent call-history Git repo per Workflow run. */
  readonly root: string;
  /** Commit author. Defaults to stepdaddy. */
  readonly author?: { readonly name: string; readonly email: string };
};

/**
 * Create a persistent local Node adapter backed by Git repos under `root`.
 *
 * Use `local()` for development and integration tests where call records should
 * survive process restarts and be inspectable with normal Git tooling. This is
 * Node-only and uses native local filesystem/Git behavior underneath; use
 * `memory()` for pure ephemeral unit tests.
 */
export function local(options: LocalOptions): LocalAdapter {
  return {
    kind: "local",
    store: localCallStore({
      mountRoot: options.root,
      ...(options.author !== undefined ? { author: options.author } : {}),
    }),
  } as InternalStepdaddyAdapter as LocalAdapter;
}
