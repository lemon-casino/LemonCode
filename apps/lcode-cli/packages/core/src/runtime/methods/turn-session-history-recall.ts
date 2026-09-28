import { traceContextToLogContext } from "../deps.js";
import { systemReminderAttachmentEntry } from "../../agent/message-history.js";
import {
  SESSION_HISTORY_AUTO_RECALL_BOUNDS,
  SESSION_HISTORY_AUTO_RECALL_RESULT_LIMIT,
  formatSessionHistoryAutoRecallAttachment,
} from "../../session-context/session-history-auto-recall.js";
import { isSessionHistorySearchTaskType } from "../../session-context/session-history-search.js";
import { searchSessionHistory } from "../../session-context/session-history-search-service.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { appendTurnRequestEntries } from "./turn-output-token-continuation.js";

export async function appendSessionHistoryRecallForTurn(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): Promise<void> {
  if (
    state.sessionHistoryRecallAttempted ||
    state.modelStepCount !== 0 ||
    state.turnRequestState.outputTokenContinuationCount > 0
  ) {
    return;
  }

  // attempt 必须先于配置判断和 I/O 落位；同 turn 的 failover/tool continuation 不能重跑。
  state.sessionHistoryRecallAttempted = true;
  if (runtime.config.sessionRecall?.enabled !== true) return;
  if (!isSessionHistorySearchTaskType(runtime.config.taskType ?? "interactive")) return;

  const query = state.turnRecallQuery?.trim();
  if (!query) return;

  const startedAt = Date.now();
  try {
    const output = await searchSessionHistory({
      abortSignal: state.turnAbortSignal,
      bounds: SESSION_HISTORY_AUTO_RECALL_BOUNDS,
      currentSessionId: runtime.sessionId,
      query,
      requestedLimit: SESSION_HISTORY_AUTO_RECALL_RESULT_LIMIT,
      sessionStore: runtime.sessionStore,
      workspaceIdentity: runtime.config.workspaceIdentity?.toString(),
      workspaceRoot: runtime.workspaceRoot,
    });
    if (output.status === "unavailable") {
      runtime.logger?.warn("Session history recall unavailable", {
        ...traceContextToLogContext(state.turnTraceContext),
        durationMs: Date.now() - startedAt,
        event: "session_history.recall.unavailable",
        module: "core.runtime",
        reason: output.reason,
        retryable: output.retryable,
      });
      return;
    }

    const attachment = formatSessionHistoryAutoRecallAttachment(output);
    if (attachment) {
      appendTurnRequestEntries(state.turnRequestState, [
        systemReminderAttachmentEntry("session_recall", attachment),
      ]);
    }
    runtime.logger?.debug("Session history recall completed", {
      ...traceContextToLogContext(state.turnTraceContext),
      candidateSessionCount: output.candidateSessionCount,
      durationMs: Date.now() - startedAt,
      event: "session_history.recall.completed",
      failedSessionCount: output.failedSessionCount,
      matchCount: output.matches.length,
      module: "core.runtime",
      outputCharacterCount: attachment?.length ?? 0,
      projectedCharacterCount: output.projectedCharacterCount,
      scannedMessageCount: output.scannedMessageCount,
      scannedSessionCount: output.scannedSessionCount,
      truncated: output.truncated,
    });
  } catch (error) {
    if (state.turnAbortSignal.aborted) return;
    // 自动召回只是辅助上下文；异常不能阻断主 turn，也不能回退注入未过滤 transcript。
    runtime.logger?.warn("Session history recall failed", {
      ...traceContextToLogContext(state.turnTraceContext),
      durationMs: Date.now() - startedAt,
      errorName: error instanceof Error ? error.name : "UnknownError",
      event: "session_history.recall.failed",
      module: "core.runtime",
    });
  }
}
