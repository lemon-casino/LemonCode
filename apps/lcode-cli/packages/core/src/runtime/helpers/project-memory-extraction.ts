import {
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_DATA_BYTES,
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_MESSAGE_ROWS,
  SESSION_TRANSCRIPT_SNAPSHOT_MAX_PART_ROWS,
} from "@lcode/contracts";
import { selectActiveConversationBranch, type TraceContext } from "../deps.js";
import { projectSessionHistorySearchText } from "../../session-context/session-history-search.js";
import { canReadSessionContextFromWorkspace } from "../../session-context/workspace-session-scope.js";
import {
  createMemoryExtractionScheduler,
  messagesAfterLastMemoryReviewTurn,
  type MemoryExtractionScheduler,
  type MemoryExtractionSnapshot,
} from "../../memory/extraction.js";
import { runAutomaticMemoryReview } from "../../memory/automatic-review.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  captureProjectMemoryAgentContext,
  type ProjectMemoryAgentContext,
} from "./project-memory-agent.js";
import { resolveEnabledProjectMemoryRoot } from "./project-memory.js";

const EXTRACTION_DRAIN_TIMEOUT_MS = 60_000;
const REAL_USER_PROBE_CHARACTER_LIMIT = 1;
const AUTOMATIC_REVIEW_QUERY =
  "Review the completed user turn for durable project facts and corrections; save only independently verified, reusable changes.";

interface ProjectMemoryExtractionSnapshot
  extends MemoryExtractionSnapshot, ProjectMemoryAgentContext {
  sessionId: AgentRuntimeInternal["sessionId"];
  workspaceIdentity?: string;
}

export type ProjectMemoryExtractionScheduler =
  MemoryExtractionScheduler<ProjectMemoryExtractionSnapshot>;

export function isProjectMemoryEnabled(this: AgentRuntimeInternal): boolean {
  return resolveEnabledProjectMemoryRoot(this.config, this.workspaceRoot) !== undefined;
}

export function scheduleProjectMemoryExtraction(
  runtime: AgentRuntimeInternal,
  input: { model: ProjectMemoryAgentContext["model"]; traceContext: TraceContext },
): void {
  if (runtime.shuttingDown) return;
  // 原因：headless 只关闭自动 Extraction，必须在读取快照或访问文件前返回，避免后台副作用。
  if (runtime.config.memory?.extractionEnabled === false) return;
  // Bash cd 只改变执行 cwd，project Memory 身份必须继续使用会话 workspace root。
  const memoryRoot = resolveEnabledProjectMemoryRoot(runtime.config, runtime.workspaceRoot);
  if (!memoryRoot) return;
  if (runtime.isRemoteWorkspace()) return;
  // 缺受控提交或有界快照能力时不回退旧 memory loop，避免未经独立复核的写入。
  if (!runtime.sessionStore?.readTranscriptWindow || !runtime.fileSystemPort?.projectMemory) return;

  const snapshotBase = {
    ...captureProjectMemoryAgentContext(runtime, {
      memoryRoot,
      model: input.model,
      operation: "project_memory_extract",
      traceContext: input.traceContext,
    }),
    sessionId: runtime.sessionId,
    workspaceIdentity: runtime.config.memory?.workspaceIdentity,
  };
  const snapshotBoundaryMessageId = runtime.latestConversationMessageId;
  if (!snapshotBoundaryMessageId) return;
  // 全量 messages 再切片既无 IO 预算，也会把 getSession 与历史读成两代；窗口连同元数据原子读取。
  const snapshot = runtime.sessionStore
    .readTranscriptWindow({
      sessionID: snapshotBase.sessionId,
      throughMessageID: snapshotBoundaryMessageId,
      limits: {
        maxMessageRows: SESSION_TRANSCRIPT_SNAPSHOT_MAX_MESSAGE_ROWS,
        maxPartRows: SESSION_TRANSCRIPT_SNAPSHOT_MAX_PART_ROWS,
        maxDataBytes: SESSION_TRANSCRIPT_SNAPSHOT_MAX_DATA_BYTES,
      },
    })
    .then((window): ProjectMemoryExtractionSnapshot => {
      const scheduledSession = window.session;
      if (
        !window.boundaryFound ||
        window.throughMessageID !== snapshotBoundaryMessageId ||
        window.truncated ||
        !scheduledSession ||
        scheduledSession.id !== snapshotBase.sessionId ||
        !canReadSessionContextFromWorkspace(scheduledSession, snapshotBase)
      ) {
        throw new Error("Extraction completed window is unavailable");
      }
      const activeMessages = selectActiveConversationBranch(window.messages, {
        branchCutAfterMessageId: scheduledSession.revert?.branchCutAfterMessageID,
        rewindCreatedMessageId: scheduledSession.revert?.createdMessageID,
        rewindKeptMessageIds: scheduledSession.revert?.keptMessageIDs,
        rewindTargetMessageId: scheduledSession.revert?.targetMessageID,
      });
      const boundaryIndex = activeMessages.findIndex(
        (message) => message.info.id === snapshotBoundaryMessageId,
      );
      if (boundaryIndex < 0) {
        throw new Error("Extraction boundary is missing from the scheduled active branch");
      }
      const durableMessages = messagesAfterLastMemoryReviewTurn(
        activeMessages.slice(0, boundaryIndex + 1),
      );
      const realUserText = projectSessionHistorySearchText({
        messages: durableMessages.filter((message) => message.info.role === "user"),
        session: { ...scheduledSession, revert: undefined },
        characterLimit: REAL_USER_PROBE_CHARACTER_LIMIT,
      });
      // prefixTruncated 可省略旧轮，但窗口内没有真实用户边界时不能把孤立 assistant 当本轮证据。
      if (!realUserText.searchText) throw new Error("Extraction window has no real user boundary");
      return { ...snapshotBase, boundaryMessageId: snapshotBoundaryMessageId, durableMessages };
    });

  runtime.memoryExtractionScheduler ??= createMemoryExtractionScheduler((extraction) =>
    executeProjectMemoryExtraction(runtime, extraction),
  );
  runtime.memoryExtractionScheduler.schedule(snapshot);
}

export async function drainMemoryExtractions(
  this: AgentRuntimeInternal,
  timeoutMs: number | null = EXTRACTION_DRAIN_TIMEOUT_MS,
): Promise<void> {
  const scheduler = this.memoryExtractionScheduler;
  if (!scheduler) return;
  // benchmark 显式等待自然结束；普通 session close 仍保留原有有界取消清理。
  if (timeoutMs === null) {
    await scheduler.drain();
    return;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      scheduler.drain(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function executeProjectMemoryExtraction(
  runtime: AgentRuntimeInternal,
  input: {
    abortSignal: AbortSignal;
    messageCount: number;
    snapshot: ProjectMemoryExtractionSnapshot;
  },
) {
  const telemetry = runtime.agentTelemetry.detached({
    causation: input.snapshot.causation,
    executionKind: "background",
    operation: "project_memory_extract",
    targetKind: "project_memory",
    traceContext: input.snapshot.traceContext,
    trigger: "scheduler",
  });

  return telemetry.run(async () => {
    try {
      input.abortSignal.throwIfAborted();
      if (!runtime.fileSystemPort?.projectMemory || !runtime.sessionStore?.readTranscriptWindow) {
        telemetry.finishCompleted();
        return "no-op" as const;
      }
      const snapshot = input.snapshot;
      // 两次辅助请求各自构造 tools=[] 的新证据上下文，不继承前景回答或执行任何模型工具。
      const result = await runAutomaticMemoryReview({
        query: AUTOMATIC_REVIEW_QUERY,
        context: {
          abortSignal: input.abortSignal,
          fileSystemPort: runtime.fileSystemPort,
          sessionStore: runtime.sessionStore,
          sessionId: snapshot.sessionId,
          toolCallId: `memory_extract_${snapshot.boundaryMessageId}`,
          traceContext: snapshot.traceContext,
          traceId: snapshot.traceContext.traceId,
          spanId: snapshot.traceContext.spanId,
          parentSpanId: snapshot.traceContext.parentSpanId,
          turnId: snapshot.traceContext.turnId,
          model: snapshot.model,
          memoryRoot: snapshot.memoryRoot,
          workingDirectory: snapshot.workingDirectory,
          workspaceRoot: snapshot.workspaceRoot,
          workspaceIdentity: snapshot.workspaceIdentity,
          runtimeScope: "main",
          reviewMode: "incremental",
          reviewBoundary: { sessionId: snapshot.sessionId, messageId: snapshot.boundaryMessageId },
        },
      });
      input.abortSignal.throwIfAborted();
      // 冲突优先保留前景版本与 cursor；不在后台自动重试，仅后续新快照可以重新形成候选。
      if (result.conflictCount > 0) {
        telemetry.finishFailed(
          "execute",
          "internal",
          new Error(`Automatic memory review had ${result.conflictCount} commit conflicts`),
        );
        return "error" as const;
      }
      telemetry.finishCompleted();
      return result.appliedCount > 0 ? ("success" as const) : ("no-op" as const);
    } catch (error) {
      if (input.abortSignal.aborted || isAbortError(error)) {
        telemetry.finishCancelled("abort_signal");
        return "aborted" as const;
      }
      telemetry.finishFailed("execute", "internal", error);
      return "error" as const;
    }
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
