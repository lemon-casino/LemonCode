import {
  SessionEventType,
  type UserInputAutoResolutionUpdatedPayload,
  type TraceContext,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

/**
 * 记录 AskUserQuestion 自动结束阶段。事件必须走 runtime 的 durable append/sink 链路，
 * 让 desktop continuous 与 web remote replayable 都恢复同一组绝对时间。
 */
export async function recordUserInputAutoResolutionUpdate(
  this: AgentRuntimeInternal,
  input: UserInputAutoResolutionUpdatedPayload & { traceContext?: TraceContext },
): Promise<void> {
  const traceContext = input.traceContext ?? this.rootTraceContext;
  await this.appendEvent(
    this.createEvent(
      SessionEventType.UserInputAutoResolutionUpdated,
      {
        interactionId: input.interactionId,
        toolCallId: input.toolCallId,
        autoResolution: input.autoResolution,
      } satisfies UserInputAutoResolutionUpdatedPayload,
      traceContext,
    ),
    traceContext,
  );
}
