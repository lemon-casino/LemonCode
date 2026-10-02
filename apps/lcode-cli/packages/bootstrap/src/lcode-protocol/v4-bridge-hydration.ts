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

import { SessionEventType } from "@lcode/contracts";

import type {
  DynamicWorkflowRunProgressPayload,
  EventId,
  SessionEvent,
  SessionId,
  TraceId,
} from "@lcode/contracts";

import { HYDRATION_TRACE_ID } from "../lcode-protocol-v4/projection-state.js";

import { resolveSessionModelContextWindow } from "./workspace-model-runtime.js";

import { listSessionSubagents, readSessionContextUsage } from "./server-operations.js";

import type {
  LCodeProtocolAgentServerContext,
  LCodeProtocolSessionRecord,
} from "./server-types.js";

import { createProtocolLogger } from "./server-types.js";

import { cumulativeFromPersistedMessages } from "./session-usage-cumulative.js";

import type { MessageWithParts } from "@lcode/contracts";

import { resolveConversationBackingRecord } from "./v4-bridge-backing-record.js";

export function sessionUsageSeedFromRuntimeContextUsage(
  contextUsage: LCodeSessionContextUsage | undefined,
  contextWindowOverride?: number,
  persistedMessages?: readonly MessageWithParts[],
): SessionUsageSeed | null {
  const recoveredCumulative = persistedMessages
    ? cumulativeFromPersistedMessages(persistedMessages)
    : null;
  if (!contextUsage || contextUsage.used <= 0) {
    return recoveredCumulative
      ? {
          contextWindow: {
            usedTokens: 0,
            maxTokens: contextWindowOverride ?? null,
            autoCompactThresholdTokens: null,
          },
          cumulative: recoveredCumulative,
        }
      : null;
  }
  return {
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
    loadPersistedEvents: async (sessionId, persistedMessages) => {
      // dwf workflow actor / subagent 这类 detached live child 没有自己的
      // bootstrap record（事件经 ingestDetachedLiveSession 走父 record 的 sink 路由）。
      // context.sessions.get 取不到 record 时不能直接返回 synthesized:false——
      // 否则首次订阅的 performHydration 会走"保留健康 live publisher"早退分支，
      // durable transcript 三源合并从不执行——只由 live 事件喂养的投影会丢掉所有
      // 不以 live 事件形式出现的持久正文。amend-resume 把前驱 transcript 前缀直接
      // 复制进 session store 来播种 actor 会话，
      // 这段前缀正属于此类，于是侧栏 actor transcript 只剩本次 live 增量；
      // 普通崩溃恢复后 warm 窗口同样看不到 crash 前的 actor 消息。
      // 改用 resolveConversationBackingRecord：child 自身没有 record 时按持久
      // parentID 落到父 record，只借它的共享 event/artifact store，事件读取仍显式用
      // child 自己的 sessionId（script workflow child runtime 共享父 event store，
      // 事件按 child sessionId 归档），因此 sourceEventSeq 仍是 child 的真实水位。
      // 代价：contextWindow 分母会按父 record 的当前模型解析而不是 actor 模型，纯展示层偏差。
      const record = await resolveConversationBackingRecord(context, sessionId);
      if (!record) {
        // 诊断：hydrate 预期在 runtime 已由 cold-resume 激活后执行；连父 record 兜底
        // 都落空时，返回空事件会把真实的生命周期竞态伪装成“历史为空”，必须留下明确现场。
        context.logger?.warn("LCode Protocol v4 hydrate has no active runtime", {
          activeSessionCount: context.sessions.size,
          event: "lcode_protocol.v4.hydrate_runtime_missing",
          module: "bootstrap.lcode_protocol",
          phase: "loadPersistedEvents",
          sessionId,
        });
        return { events: [], synthesized: false, sourceEventSeq: 0 };
      }
      // message/part 与 session_entry 的异步读取期间 live sink 仍可收到新事件。
      // gateway 必须知道 memory eventStore 取快照时的 raw cursor，才能只补 await 窗口内
      // 的尾部，并把 transcript 合成的 1..N 序列稳定映射回后续 runtime raw seq。
      // 内存 event store 会淘汰已完成 turn 的瞬态事件，max(events.seq) 会小于真实
      // 游标，让已淘汰的 delta 被当成 await 窗口尾部重放。两次调用之间没有 await，拿到的是
      // 同一时刻的一致快照。
      const [liveEvents, sourceEventSeq] = await Promise.all([
        record.eventStore.getEvents(sessionId as SessionId),
        record.eventStore.getLatestSequenceNumber(sessionId as SessionId),
      ]);
      // workflow run 的冷回放：journal 回放出的进度
      // 事件前置到内存事件之前——cold merge 已把该类型归为 memory-only 权威（保序进 supplements），
      // 投影经同一个 reducer 归约，`workflowRuns` 因此在重启前后一致。
      const replayed = await replayDynamicWorkflowRunEvents(context, sessionId, record, liveEvents);
      const events = replayed.length === 0 ? liveEvents : [...replayed, ...liveEvents];
      const store = context.deps.sessionStore;
      const source = await loadPersistedConversationMaterialization({
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
                      sessionEntries: (input) =>
                        store.sessionEntries!(input).catch((error) => {
                          context.logger?.warn("v4 hydrate session entries read failed", {
                            error: error instanceof Error ? error.message : String(error),
                            event: "lcode_protocol.v4.hydrate_session_entries_failed",
                            module: "bootstrap.lcode_protocol",
                          });
                          return [];
                        }),
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
        readArtifact: async (snapshotRef) =>
          (await record.app.readToolResultArtifact(snapshotRef)).content,
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
      const contextWindow = resolveSessionModelContextWindow(context, record);
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
      const subagents = await listSessionSubagents(
        context,
        { sessionId, endedLimit: 1 },
        persistedMessages,
      );
      return {
        events: merged.events,
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
