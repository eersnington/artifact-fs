export { Capsules } from "./core/capsules.js";
export { Artifacts } from "./artifacts/layers.js";
export { CapsuleError, type CapsuleErrorCode } from "./core/errors.js";
export { stableHash, digestBytes } from "./internal/hash.js";
export { redact, type RedactOptions } from "./internal/redact.js";
export { MemoryFS } from "./git/memory-fs.js";
export { computeTreeDiff, type TreeDiff } from "./git/diff.js";

export type {
  ArtifactLayer,
  CapsuleDedupe,
  CapsuleDefinition,
  CapsuleEffectDetails,
  CapsuleEffects,
  CapsuleFailure,
  CapsuleFileBody,
  CapsuleFileOptions,
  CapsuleFileRef,
  CapsuleFiles,
  CapsuleRefs,
  CapsuleRunContext,
  CapsuleSpec,
  CapsulesService,
  DefinedCapsule,
  EffectRecord,
  FailureManifest,
  HostedArtifactLayer,
  InspectedRun,
  LocalBridgeArtifactLayer,
  LocalNodeArtifactLayer,
  MemoryArtifactLayer,
  RunIndex,
  RunIndexEntry,
  StandardSchemaV1,
  StepManifest,
  WorkersArtifactLayer,
  WorkflowEventLike,
  WorkflowStepContextLike,
} from "./core/types.js";

export type {
  ArtifactsBindingLike,
  ArtifactsCreatedRepoLike,
  ArtifactsRepoHandleLike,
  GitOps,
  GitWorkspace,
  WorkersStoreOptions,
} from "./artifacts/workers.js";
export type { LocalNodeOptions } from "./artifacts/local-node.js";
export type { HttpStoreOptions } from "./artifacts/hosted.js";
