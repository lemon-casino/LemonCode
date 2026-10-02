import type { MessageId, ModelToolContract } from "../deps.js";
import { type RuntimeMessageEntry } from "../../agent/message-history.js";
import type { DrainedPendingInputDiagnostics, RunModelTextRequestOptions } from "../types.js";
import type { captureAssistantPersistenceAnchor } from "./turn-stop.js";
import type { createStreamingToolCoordinator } from "./streaming-tool-coordinator.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import type { querySourceForTask } from "./turn-model-step-usage.js";

export type ModelStepResult = "continue" | "output_continuation" | "break";

export type ModelStepOptions = {
  drainedSteerForNextRequest?: DrainedPendingInputDiagnostics;
  latestRealUserMessageIndex?: number;
  messages: RunModelTextRequestOptions["messages"];
  sourceEntries: readonly (RuntimeMessageEntry | undefined)[];
  recordedMessages: RunModelTextRequestOptions["messages"];
  requestEntries: readonly RuntimeMessageEntry[];
  tools: ModelToolContract[];
};

export interface ModelStepExecution {
  assistantCreatedAt: number;
  assistantMessageId: MessageId;
  assistantPersistenceAnchor: ReturnType<typeof captureAssistantPersistenceAnchor>;
  executionContextWindow: number;
  executionModelSelection: {
    providerId: RegularTurnLoopState["model"]["providerId"];
    modelId: RegularTurnLoopState["model"]["modelId"];
  };
  getRetryRequestIdentity: () => string;
  model: RegularTurnLoopState["model"];
  modelStartedAt: number;
  modelStepIndex: number;
  modelTraceContext: RegularTurnLoopState["turnTraceContext"];
  networkEventStartIndex: number;
  querySource: ReturnType<typeof querySourceForTask>;
  streamingToolCoordinator: ReturnType<typeof createStreamingToolCoordinator>;
}
