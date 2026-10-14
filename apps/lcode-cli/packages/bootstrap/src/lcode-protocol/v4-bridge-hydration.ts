import type { V4GatewayHost } from "../lcode-protocol-v4/v4-gateway.js";

// v4 网关 binder。
// 定位：ConversationV4Gateway 是域无关的通道运行时，本文件把它绑到协议服务器上下文：
// - 帧出口 = context.notify（stdio NDJSON notification，与旧 session/event 同一条管道并存）；
// - 命令执行 = V4CommandExecutor（lcode-protocol-v4/commands/，原生直驱 core）；
//   20 命令全部原生，supports() 未命中（未知命令）→ notImplemented。
// - 过渡钩子（ensureModelReady / afterLegacyStateMutation / closeSession /
//   createSessionRecord / child record registration / resumePersistedSession）在此注入旧协议实现，随旧协议一同删除。
//
// 不做桥接：依赖方向只允许 旧目录 → v4 目录。
// 本文件在旧目录，import v4 executor 合法；v4 目录禁止反向 import 本目录任何模块。
import { type LCodeSessionContextUsage } from "@lcode/shared";

import { buildColdFileChangeSummaries } from "../lcode-protocol-v4/cold-file-change-summaries.js";

import {
  loadPersistedConversationMaterialization,
  mergeColdConversationEvents,
} from "../lcode-protocol-v4/cold-event-merge.js";

import type { SessionUsageSeed } from "../lcode-protocol-v4/product-projection.js";
import { contextTrendFromPersistedMessages } from "../lcode-protocol-v4/session-context-trend.js";

import { SessionEventType } from "@lcode/contracts";

import type {
  DynamicWorkflowRunProgressPayload,
  EventId,
  SessionEvent,
  SessionId,
  TraceId,
} from "@lcode/contracts";

import { HYDRATION_TRACE_ID } from "../lcode-protocol-v4/projection-state.js";

import { listSessionSubagents, readSessionContextUsage } from "./server-operations.js";

import type {
  LCodeProtocolAgentServerContext,
  LCodeProtocolSessionRecord,
} from "./server-types.js";

import { createProtocolLogger } from "./server-types.js";

import { cumulativeFromPersistedMessages } from "./session-usage-cumulative.js";

import type { MessageWithParts } from "@lcode/contracts";

import { resolveConversationReader } from "./conversation-reader.js";

export function sessionUsageSeedFromRuntimeContextUsage(
  contextUsage: LCodeSessionContextUsage | undefined,
  contextWindowOverride?: number,
  persistedMessages?: readonly MessageWithParts[],
): SessionUsageSeed | null {
  const recoveredCumulative = persistedMessages
    ? cumulativeFromPersistedMessages(persistedMessages)
    : null;
  const contextTrend = persistedMessages
    ? contextTrendFromPersistedMessages(persistedMessages)
    : undefined;
  if (!contextUsage || contextUsage.used <= 0) {
    return recoveredCumulative || contextTrend?.samples.length
      ? {
          ...(contextTrend ? { contextTrend } : {}),
          contextWindow: {
            usedTokens: 0,
            maxTokens: contextWindowOverride ?? null,
            autoCompactThresholdTokens: null,
          },
          ...(recoveredCumulative ? { cumulative: recoveredCumulative } : {}),
        }
      : null;
  }
  return {
    ...(contextTrend ? { contextTrend } : {}),
    contextWindow: {
      usedTokens: contextUsage.used,
      maxTokens: contextWindowOverride ?? null,
      autoCompactThresholdTokens: null,
      ...(contextUsage.cache ? { cache: contextUsage.cache } : {}),
      ...(contextUsage.breakdown ? { breakdown: contextUsage.breakdown } : {}),
    },
    ...(recoveredCumulative ? { cumulative: recoveredCumulative } : {}),
  };
}

/**
 * 冷物化时把本会话的 workflow run 从 journal 回放成 `DynamicWorkflowRunProgress` 会话事件。
 *
 *   - 只对**直接命中** record 的父会话补种：经 parentID 回落到父 record 的子会话（actor
 *     transcript）不补——journal 按父会话建键，子会话的投影不该长出父会话的 run；
 *   - 内存事件里已出现过的 runId 交给 CLI 排除（本进程跑过的 run 事件全在内存 store 里，
 *     进度事件不带 turnId、不受 turn-window 淘汰），暖物化因此零重复；
 *   - 回放失败只记日志、回空：观察面绝不让冷开失败。
 *
 * 事件 id / traceId 照 transcript hydration 的合成事件；sequenceNumber 由 cold merge 统一重排。
 */
async function replayDynamicWorkflowRunEvents(
  context: LCodeProtocolAgentServerContext,
  sessionId: string,
  record: LCodeProtocolSessionRecord,
  memoryEvents: readonly SessionEvent[],
): Promise<SessionEvent[]> {
  if (context.sessions.get(sessionId) !== record) return [];
  const replay = record.app.replayDynamicWorkflowRuns;
  if (!replay) return [];
  const excludeRunIds = new Set<string>();
  for (const event of memoryEvents) {
    if (event.type !== SessionEventType.DynamicWorkflowRunProgress) continue;
    const runId = (event.payload as { runId?: unknown } | undefined)?.runId;
    if (typeof runId === "string") excludeRunIds.add(runId);
  }
  let payloads: DynamicWorkflowRunProgressPayload[];
  try {
    payloads = await replay({ excludeRunIds });
  } catch (error) {
    context.logger?.warn("v4 hydrate dynamic workflow replay failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "lcode_protocol.v4.hydrate_workflow_replay_failed",
      module: "bootstrap.lcode_protocol",
      sessionId,
    });
    return [];
  }
  return payloads.map((payload, index) => ({
    id: `dwf-replay-${index + 1}` as EventId,
    sessionId: sessionId as SessionId,
    type: SessionEventType.DynamicWorkflowRunProgress,
    timestamp: new Date(0),
    traceId: HYDRATION_TRACE_ID as TraceId,
    sequenceNumber: 0,
    payload,
  }));
}

export function createV4HydrationHost(
  context: LCodeProtocolAgentServerContext,
  log: ReturnType<typeof createProtocolLogger>,
): Pick<V4GatewayHost, "loadPersistedEvents"> {
  return {
    // 冷订阅不再在 eventStore / transcript 之间 XOR。message/part
    // 是已完成正文权威，session_entry 只补 legacy goal，内存事件只补
    // 未持久 in-flight 和 queue/permission/control 等 ephemeral 状态。
    loadPersistedEvents: async (sessionId, persistedMessages, workspace) => {
      // 观察读取与执行 READY 分离；无 parent runtime 时仍读取同一持久源。
      const reader = await resolveConversationReader(context, sessionId, workspace);
      const { record, memoryEvents: liveEvents, sourceEventSeq } = reader;
      // workflow run 的冷回放：journal 回放出的进度
      // 事件前置到内存事件之前——cold merge 已把该类型归为 memory-only 权威（保序进 supplements），
      // 投影经同一个 reducer 归约，`workflowRuns` 因此在重启前后一致。
      const replayed = record
        ? await replayDynamicWorkflowRunEvents(context, sessionId, record, liveEvents)
        : [];
      const events = replayed.length === 0 ? liveEvents : [...replayed, ...liveEvents];
      const store = context.deps.sessionStore;
      const source = await loadPersistedConversationMaterialization({
        workspaceEventsFromEntries: reader.workspaceEventsFromEntries,
        memoryEvents: events,
        persistedMessages,
        sessionId,
        ...(store
          ? {
              store: {
                getSession: (id) => store.getSession(id),
                messages: (input) => store.messages(input),
                readTarget: (input) => store.readTarget(input),
                ...(store.sessionEntries
                  ? {
                      sessionEntries: (input) => store.sessionEntries!(input),
                    }
                  : {}),
              },
            }
          : {}),
      });
      // live ModelComplete.fileChanges 只存在于内存事件；cold merge 以持久
      // transcript 为正文权威时会压掉该事件，而 transcript 本身没有文件摘要字段。
      // workspace checkpoint + artifact 才是跨进程持久事实，这里按 user messageId
      // 重建摘要，再交给 transcript hydration 合成同构 ModelComplete。
      const fileChangeSummariesByMessageId = await buildColdFileChangeSummaries({
        events: source.memoryEvents,
        messageIds: source.messages.map((message) => String(message.info.id)),
        readArtifact: async (snapshotRef) => reader.readArtifact(snapshotRef),
        onArtifactError: (messageId, error) =>
          context.logger?.warn("v4 cold file change artifact read failed", {
            error: error instanceof Error ? error.message : String(error),
            event: "lcode_protocol.v4.hydrate_file_changes_failed",
            messageId,
            module: "bootstrap.lcode_protocol",
            sessionId,
          }),
      });
      // 冷恢复 transcript 不保存模型能力，旧 hydration 自行填 20 万；
      // provider registry 已在 resume 前同步完成，应按恢复/退避后的当前模型精确取值。
      const configuration = await reader.configuration(source.messages, source.memoryEvents);
      const contextWindow = configuration.contextWindow;
      const usageSeed = sessionUsageSeedFromRuntimeContextUsage(
        await readSessionContextUsage(context, sessionId, source.messages),
        contextWindow,
        source.messages,
      );
      const merged = mergeColdConversationEvents({
        contextWindow,
        fileChangeSummariesByMessageId,
        memoryEvents: source.memoryEvents,
        messages: source.messages,
        sessionId,
        goalVerificationEntries: source.goalVerificationEntries,
        ...(Object.prototype.hasOwnProperty.call(source, "target")
          ? { target: source.target }
          : {}),
      });
      for (const diagnostic of merged.diagnostics) {
        const fields = {
          ...diagnostic,
          event: "lcode_protocol.v4.hydrate_three_source_merge",
          module: "bootstrap.lcode_protocol",
          sessionId,
        };
        if (
          diagnostic.code === "cold_merge.ambiguous_legacy_turn_preserved" ||
          diagnostic.code === "cold_merge.memory_boundary_preserved" ||
          diagnostic.code === "cold_merge.unclassified_event_preserved"
        ) {
          context.logger?.warn("v4 hydrate preserved ambiguous cold fact", fields);
        } else {
          log?.debug("v4 hydrate merged duplicate cold facts", fields);
        }
      }
      // transcript 可恢复 Agent row，却不能证明 child session 已经落库。
      // 这里在 gateway 的 raw-event buffer 补回前生成校验种子，既排除旧幽灵引用，
      // 又避免异步查询覆盖 seed 之后新到达的 live spawn/stop。
      const subagents =
        !reader.stored && record?.persistence === "deferred"
          ? { revision: record.stateRevision, childSessionIds: [], running: [] }
          : await listSessionSubagents(context, { sessionId, endedLimit: 1 }, persistedMessages);
      return {
        events: merged.events,
        configSeed: configuration.configSeed,
        // 与合成事件共用本次查询结果；不在后续回填阶段重新读取另一份容量。
        usageSeed,
        // gateway 旧字段名仍叫 synthesized；这里表示投影已由 durable
        // transcript 重物化，需替换 ingest 抢先建的 cold publisher。
        synthesized: merged.usedDurableTranscript,
        subagentsSeed: {
          revision: subagents.revision,
          childSessionIds: subagents.childSessionIds,
          running: subagents.running,
        },
        ...(source.sharedContextImport ? { sharedContextImport: source.sharedContextImport } : {}),
        sourceEventSeq,
      };
    },
  };
}
