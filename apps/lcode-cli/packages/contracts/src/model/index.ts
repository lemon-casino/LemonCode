export * from "./image-media.js";

export * from "./model.js";

export * from "./invocation-context.js";

// Re-export for backwards compatibility with code using ToolCall
export type { ModelToolCall as ToolCall } from "./message-content.js";

export * from "./content-protection.js";

export {
  ModelErrorCode,
  ModelProtocolError,
  createModelProviderId,
  createModelId,
} from "./protocol-identity.js";

export type { JsonSchema, ModelProviderId, ModelId } from "./protocol-identity.js";

export { ModelRequestSessionType, ModelRetryBudget } from "./request-control.js";

export type {
  ModelRequestAdmissionTicket,
  ModelRequestAdmission,
  ModelRequestTarget,
  ModelRetryYieldInput,
  ModelRetryYieldDecision,
  ModelRetryYieldGate,
} from "./request-control.js";

export { ModelTransportKind, ModelRetryReason, ModelFailureReason } from "./network-status.js";

export type {
  ModelStreamRecoveryStatus,
  ModelRequestStartedStatusEvent,
  ModelRequestQueuedStatusEvent,
  ModelRequestAdmittedStatusEvent,
  ModelRequestCompletedStatusEvent,
  ModelRequestFailedStatusEvent,
  ModelRetryScheduledStatusEvent,
  ModelStreamStalledStatusEvent,
  ModelTelemetryMilestoneStatusEvent,
  ModelNetworkStatusEvent,
  ModelStatusSink,
} from "./network-status.js";

export { modelMessageContentToText, modelMessageContentBlockToText } from "./message-content.js";

export type {
  ModelMessageRole,
  ModelToolCall,
  AttachmentKind,
  AttachmentRef,
  ModelTextContentBlock,
  ModelReasoningContentBlock,
  ModelImageContentBlock,
  ModelFileContentBlock,
  ModelVideoContentBlock,
  ModelResourceLinkContentBlock,
  ModelMessageContentBlock,
  ModelMessageContent,
  ModelCacheControl,
  ModelInputMessage,
} from "./message-content.js";

export type {
  ModelToolExecutionContext,
  ModelToolSideEffectScope,
  ModelToolContract,
  ModelToolChoice,
} from "./tool-contracts.js";

export {
  getModelUsageTotalTokens,
  getModelUsageContextTokens,
  getModelUsageInputWindowTokens,
  hasModelUsage,
  createModelUsageSummary,
} from "./usage.js";

export type { ModelServerToolUsage, ModelUsage, ModelUsageSummary } from "./usage.js";

export type { ModelRequestSettings, ModelTextRequest } from "./text-request.js";

export type {
  ModelSource,
  ModelToolResult,
  ModelTextResult,
  ModelStreamEvent,
} from "./text-result.js";

export {
  modelSelectionJsonSchema,
  modelInputMessageJsonSchema,
  modelTextRequestJsonSchema,
  modelNetworkStatusEventJsonSchema,
} from "./json-schema.js";
