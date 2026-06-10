export {
  createCapsules,
  defineExternalCall,
  type CreateCapsulesOptions,
} from "./core/capsules.js";
export { CapsuleError, type CapsuleErrorCode } from "./core/errors.js";

export type {
  Capsules,
  ExternalCall,
  ExternalCallExecuteContext,
  ExternalCallRecovery,
  ExternalCallRunContext,
  ExternalCallSpec,
  ExternalCallSummaryContext,
  ProviderSummary,
  ReconcileContext,
  ReconcileResult,
  StandardSchemaV1,
  WorkflowEventLike,
  WorkflowStepContextLike,
} from "./core/types.js";
