import { SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION } from "../deps.js";
import type {
  MessageId,
  MessageProjectionAnchor,
  SessionEntryInfo,
  SessionGoal,
  TraceContext,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

interface VerificationEntryPayload {
  anchorAssistantMessageId?: string;
  targetId?: string;
}

/**
 * 在 TurnComplete 对订阅者可见前，把 fork 所需的历史事实固定到最终 assistant。
 * productTurnId 属于 bootstrap 投影域，这里只固定 core 权威的 raw message segment；
 * resolver 会用 projection candidate 补 productTurnId，禁止 core 复制 `~qN` 算法。
 */
export async function persistStableForkCompletionBoundary(
  runtime: AgentRuntimeInternal,
  input: {
    boundaryMessageId: MessageId;
    startMessageId: MessageId;
    historyRoundCount: number;
    traceContext: TraceContext;
  },
): Promise<void> {
  const store = runtime.sessionStore;
  if (!store) return;

  const messages = await store.messages({ sessionID: runtime.sessionId });
  const boundaryIndex = messages.findLastIndex(
    (message) =>
      message.info.id === input.boundaryMessageId &&
      message.info.role === "assistant" &&
      !message.info.error &&
      message.info.time.completed !== undefined,
  );
  const startIndex = messages.findLastIndex(
    (message, index) =>
      index <= boundaryIndex && message.info.id === input.startMessageId,
  );
  const boundary = messages[boundaryIndex];
  if (
    startIndex < 0 ||
    boundaryIndex < startIndex ||
    boundary?.info.role !== "assistant" ||
    boundary.info.error ||
    boundary.info.time.completed === undefined
  ) {
    // 兼容只实现部分 SessionStorePort 的旧 adapter/test double，以及 turn 收口前被
    // edit/rewind 改写的 transcript。没有 exact segment 就不写伪 anchor，resolver
    // 仍按 legacy 无歧义规则裁决。
    return;
  }

  const orderedMessageIds = messages
    .slice(startIndex, boundaryIndex + 1)
    .map((message) => message.info.id);
  const prefixMessageIds = new Set(
    messages
      .slice(0, boundaryIndex + 1)
      .map((message) => String(message.info.id)),
  );
  const target =
    typeof store.readTarget === "function"
      ? await store.readTarget({ sessionID: runtime.sessionId })
      : null;
  const goalBoundary = target
    ? {
        kind: "snapshot" as const,
        target: stableGoalSnapshot(target),
        verificationEntryIds: await verificationEntryIdsAtBoundary(
          runtime,
          target,
          prefixMessageIds,
        ),
      }
    : { kind: "none" as const };

  const anchor: MessageProjectionAnchor = {
    ...boundary.info.anchor,
    ...(input.traceContext.turnId ? { turnId: input.traceContext.turnId } : {}),
    historyRoundCount: input.historyRoundCount,
    orderedMessageIds,
    boundaryMessageId: input.boundaryMessageId,
    goalBoundary,
  };
  await store.saveMessage({ ...boundary.info, anchor });
}

function stableGoalSnapshot(target: SessionGoal): SessionGoal {
  // active run 字段属于 parent 的瞬时执行权，不是 child 可继承状态。生产 adapter 的
  // cloneTargetForFork 也会清空；anchor 同样先清空，避免查询/诊断误读为历史运行中。
  return {
    ...target,
    activeInputId: null,
    activeRunStartedAtMs: null,
    activeRunLastSeenAtMs: null,
    time: { ...target.time },
  };
}

async function verificationEntryIdsAtBoundary(
  runtime: AgentRuntimeInternal,
  target: SessionGoal,
  prefixMessageIds: ReadonlySet<string>,
): Promise<string[]> {
  const store = runtime.sessionStore;
  if (!store?.sessionEntries) {
    // 有 goal 却无法读取 verifier ledger 时不能伪造空边界，否则 child 可能静默丢失
    // fork 点前 verifier。显式失败会阻止 TurnComplete/canFork 先于权威 anchor 发布。
    return [];
  }
  const entries = await store.sessionEntries({
    sessionID: runtime.sessionId,
    type: SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  });
  return entries.flatMap((entry) => {
    const payload = verificationEntryPayload(entry);
    if (payload?.targetId !== target.targetID) return [];
    if (
      payload.anchorAssistantMessageId &&
      !prefixMessageIds.has(payload.anchorAssistantMessageId)
    ) {
      return [];
    }
    return [entry.id];
  });
}

function verificationEntryPayload(
  entry: SessionEntryInfo,
): VerificationEntryPayload | null {
  if (
    !entry.data ||
    typeof entry.data !== "object" ||
    Array.isArray(entry.data)
  )
    return null;
  const payload = (entry.data as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const record = payload as Record<string, unknown>;
  return {
    ...(typeof record.targetId === "string"
      ? { targetId: record.targetId }
      : {}),
    ...(typeof record.anchorAssistantMessageId === "string"
      ? { anchorAssistantMessageId: record.anchorAssistantMessageId }
      : {}),
  };
}
