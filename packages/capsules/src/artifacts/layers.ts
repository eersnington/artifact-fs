import type {
  ArtifactLayer,
  HostedArtifactLayer,
  LocalBridgeArtifactLayer,
  LocalNodeArtifactLayer,
  MemoryArtifactLayer,
  WorkersArtifactLayer,
} from "../core/types.js";
import { createTreeBackend } from "./tree-backend.js";
import { memoryStore } from "./memory.js";
import {
  workersStore,
  type ArtifactsBindingLike,
  type WorkersStoreOptions,
} from "./workers.js";
import { localNodeStore, type LocalNodeOptions } from "./local-node.js";
import { httpStore } from "./hosted.js";

/**
 * Artifact layer constructors. Pick the backend once when configuring
 * `Capsules.layer(...)`; Workflow step bodies never change across layers.
 */
export const Artifacts = {
  /** In-memory store for tests, examples, and deterministic unit runs. */
  memory(): MemoryArtifactLayer {
    return {
      kind: "memory",
      backend: createTreeBackend(memoryStore()),
    };
  },

  /**
   * Cloudflare Artifacts via the Workers binding (`env.ARTIFACTS`). Repo and
   * token management use the binding; file writes use isomorphic-git with an
   * in-memory filesystem, which requires the `nodejs_compat` compatibility
   * flag and buffers the working tree in Worker memory (MVP caveat for very
   * large trees).
   */
  workers(
    binding: ArtifactsBindingLike,
    options?: WorkersStoreOptions,
  ): WorkersArtifactLayer {
    return {
      kind: "workers-binding",
      backend: createTreeBackend(workersStore(binding, options)),
    };
  },

  /**
   * Local Git repos under a root directory, committed with native git.
   * Node-only. Use ArtifactFS to mount/inspect the same repos.
   */
  localNode(options: LocalNodeOptions): LocalNodeArtifactLayer {
    return {
      kind: "local-node",
      backend: createTreeBackend(localNodeStore(options)),
    };
  },

  /**
   * Local HTTP bridge for `wrangler dev`: the Worker stays runtime-neutral
   * and a local bridge process owns the ArtifactFS mount and native git.
   */
  localBridge(options: { url: string }): LocalBridgeArtifactLayer {
    return {
      kind: "local-bridge",
      backend: createTreeBackend(httpStore("local-bridge", options)),
    };
  },

  /** Self-hosted or future hosted artifact service over HTTP. */
  hosted(options: { url: string; token?: string }): HostedArtifactLayer {
    return {
      kind: "hosted",
      backend: createTreeBackend(httpStore("hosted", options)),
    };
  },
} satisfies Record<string, (...args: never[]) => ArtifactLayer>;
