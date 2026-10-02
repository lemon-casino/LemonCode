import type { Logger, ModelStatusSink, ModelStreamEvent } from "@lcode/contracts";
import type { TextStreamPart, ToolSet } from "ai";
import { type AttemptAdmission } from "./request-admission.js";
import type { ResolvedAiSdkModelRetryOptions } from "./retry-policy.js";
import { createStreamDiagnostics } from "./runner-diagnostics.js";
import { type DeferredRetryYieldGate } from "./runner-failover-yield.js";
import { TerminalStreamChunkError } from "./runner-retry.js";
import type { AiSdkModelTextRequest, ResolvedAiSdkModel } from "./runner-runtime.js";
import { createStatusContext } from "./runner-status.js";
import { StreamingToolCallAssembler } from "./streaming-tool-call-assembler.js";

export interface StreamChunkInput {
  /** 本次尝试的准入：错误块的退避 sleep 之前先归还。 */
  admission: AttemptAdmission;
  attempt: number;
  beforeRetryYieldEvaluation: () => Promise<void>;
  chunk: TextStreamPart<ToolSet>;
  diagnostics: ReturnType<typeof createStreamDiagnostics>;
  emittedRetryBoundaryEvent: boolean;
  input: {
    logger?: Logger;
    request: AiSdkModelTextRequest;
    resolved: ResolvedAiSdkModel;
    retry: ResolvedAiSdkModelRetryOptions;
    statusSink?: ModelStatusSink;
  };
  pendingRetrySafeEvents: ModelStreamEvent[];
  repairThinkingSignatureRejection: (error: unknown) => boolean;
  retryBudgetAttempt: number;
  requestHeaderCount: number;
  requestHeaders: Record<string, string>;
  startedAt: number;
  statusContext: ReturnType<typeof createStatusContext>;
  toolCallAssembler: StreamingToolCallAssembler;
}

export interface StreamChunkResult {
  deferredRetryYield?: DeferredRetryYieldGate;
  emittedError: boolean;
  emittedEvent: boolean;
  emittedRetryBoundaryEvent: boolean;
  retryScheduled: boolean;
  /** off-peak 排队重试：外层 for 冻结 attempt 预算。 */
  offPeakQueueHold: boolean;
  terminalError?: TerminalStreamChunkError;
  visibleEvents: ModelStreamEvent[];
}
