import type { TextStreamPart, ToolSet } from "ai";
import type { ModelStreamEvent } from "@lcode/contracts";
import type { ModelRunnerInput } from "./runner-request-state.js";
import type {
  AiSdkModelTextRequest,
  AiSdkStreamTextOptions,
  AiSdkStreamTextResult,
  ResolvedAiSdkModel,
} from "./runner-runtime.js";
import type { ModelStatusContext } from "./runner-status.js";
import type { createStreamDiagnostics } from "./runner-diagnostics.js";
import type { createLinkedAbortController } from "./stream-idle-timeout.js";
import type { StreamingToolCallAssembler } from "./streaming-tool-call-assembler.js";

export interface StreamRunnerInput extends ModelRunnerInput {
  streamIdleTimeoutMs: number;
}

// runStreamText 创建并拥有每个 attempt；各职责只借用自己的字段，不另建 stream、队列或清理 owner。
export interface StreamAttemptState {
  attempt: number;
  retryBudgetAttempt: number;
  startedAt: number;
  streamIdleTimeoutMs: number;
  emittedEvent: boolean;
  emittedRetryBoundaryEvent: boolean;
  emittedError: boolean;
  retryScheduledFromStreamChunk: boolean;
  offPeakQueueHoldFromStreamChunk: boolean;
  pendingRetrySafeEvents: ModelStreamEvent[];
  diagnostics: ReturnType<typeof createStreamDiagnostics>;
  attemptAbortController: ReturnType<typeof createLinkedAbortController>;
  attemptRequest: AiSdkModelTextRequest;
  statusContext: ModelStatusContext;
  toolCallAssembler: StreamingToolCallAssembler;
  streamIterator: AsyncIterator<TextStreamPart<ToolSet>> | undefined;
  streamReachedNaturalEnd: boolean;
  attemptFailed: boolean;
  awaitIteratorClose: boolean;
  terminalStatusPublished: boolean;
  options: AiSdkStreamTextOptions | undefined;
  result: AiSdkStreamTextResult | undefined;
  requestHeaders: Record<string, string>;
  requestHeaderCount: number;
  resolved: ResolvedAiSdkModel;
  timeToFirstProviderEventMs: number | undefined;
  timeToFirstContentMs: number | undefined;
  timeToFirstTextMs: number | undefined;
  streamMaxIdleMs: number;
  streamStallCount: number;
  streamOutputCommitted: boolean;
}

export interface StreamDebugOptions {
  recordModelIO: boolean;
  isDev: boolean;
}
