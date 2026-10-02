import type { SessionEvent, TraceContext, TurnId } from "@lcode/contracts";
import { isSubagentDispatchToolName } from "../compat.js";
import type { ExecutableToolCall } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";
import { isRecord } from "./utils.js";
import {
  backgroundTaskLifecycleProvider,
  type BackgroundTaskSnapshot,
} from "./background-task-lifecycle.js";
import { isDynamicWorkflowRunDispatchToolName } from "./background-task-registry.js";
import { backgroundTaskOutputMetadata } from "./background-task-output.js";
import { workflowTaskSubject } from "./workflow-task-snapshot.js";

export async function emitBackgroundTaskEvent(
  deps: ToolExecutorDeps,
  type: SessionEvent["type"],
  payload: Record<string, unknown>,
  traceContext: TraceContext,
  turnId: TurnId | undefined,
): Promise<void> {
  await deps.emitEvent({
    id: crypto.randomUUID() as any,
    sessionId: deps.sessionId,
    turnId,
    type,
    timestamp: new Date(),
    traceId: traceContext.traceId,
    sequenceNumber: 0,
    payload,
  });
}

export function backgroundTaskPayload(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  taskId: string,
  status: string,
  snapshot?: BackgroundTaskSnapshot,
  output?: Record<string, unknown>,
): Record<string, unknown> {
  const input = isRecord(toolCall.input) ? toolCall.input : {};
  const outputMetadata = backgroundTaskOutputMetadata(snapshot, output);

  return {
    taskId,
    lifecycleId: deps.runtimeTaskRegistry?.get(taskId)?.lifecycleId,
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    // V4 projection 过去从 toolName 手写推断类型，漏掉真实 Agent
    // 工具名后把后台 subagent 投成 bash/process。runtime 在事实产生处一次裁决。
    // 生命周期行为不受影响——那已经由 per-tool 的 lifecycleProvider 分派。
    taskKind: backgroundTaskKind(toolCall.name),
    childSessionId: outputMetadata.childSessionId,
    cancellable:
      status === "running" && backgroundTaskLifecycleProvider(deps, toolCall).cancellable === true,
    command: typeof input.command === "string" ? input.command : undefined,
    // CreateWorkflow 的输入 schema 里没有 `description`（只有 `{name?, script}`，
    // contracts/src/tools/create-workflow.ts），走通用的 input.description → snapshot.description
    // 链会整字段缺席，Workflows 分区的题名于是退到 toolName，每个 run 都显示成
    // "CreateWorkflow"。展示名与完成通知共用同一条兜底链（含 input.name），所以直接复用
    // workflowTaskSubject。它最后一环是 taskId（≡ runId）：投影会把它原样当题名，与缺席时
    // 退 toolName 并不相同——UI 侧约定 title ≡ workId 视同「无名」并换用 fallbackName，
    // 所以这一环到不了用户眼前，同时保住了「description 恒非空」的简单性。
    // dwf 分派名扩到 ResumeWorkflowRun：同一条兜底链（它也只有 run_id，无 description）。
    description: isDynamicWorkflowRunDispatchToolName(toolCall.name)
      ? workflowTaskSubject(toolCall, taskId, snapshot, output)
      : typeof input.description === "string"
        ? input.description
        : snapshot && "description" in snapshot
          ? snapshot.description
          : undefined,
    status,
    pid: snapshot && "pid" in snapshot ? snapshot.pid : undefined,
    startedAt: snapshot?.startedAt,
    completedAt: snapshot?.completedAt,
    outputPath: outputMetadata.outputFile,
    stderrPersistedOutputPath: outputMetadata.stderrFile,
    stdoutPersistedOutputPath: outputMetadata.stdoutFile,
    outputBytes: outputMetadata.outputBytes,
    outputTruncated: outputMetadata.outputTruncated,
    outputTail: outputMetadata.outputTail,
    stderrBytes: outputMetadata.stderrBytes,
    stderrTail: outputMetadata.stderrTail,
    stdoutBytes: outputMetadata.stdoutBytes,
    stdoutTail: outputMetadata.stdoutTail,
    terminalId: taskId,
  };
}

/**
 * 后台任务的展示类别（面板分组与图标）。`taskKind` 只是装饰：生命周期语义已经由
 * per-tool 的 lifecycleProvider 分派，所以这里的分类改动不会影响观察/等待/取消。
 *
 * legacy `Workflow`（script workflow）刻意仍归 "bash"：它不可取消、面板上也没有详情页，
 * 与 workflow run 是两种不同的东西，共用一个类别会让面板把两者混在一起。
 */
function backgroundTaskKind(toolName: string): "bash" | "subagent" | "workflow" {
  if (isSubagentDispatchToolName(toolName)) return "subagent";
  // dwf 的两个入口（CreateWorkflow / ResumeWorkflowRun）同归 "workflow"：同一个 run 的
  // 生命周期延续，面板分组与图标不该因入口不同而换类。
  return isDynamicWorkflowRunDispatchToolName(toolName) ? "workflow" : "bash";
}
