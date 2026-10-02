import { traceContextToLogContext, type TraceContext } from "@lcode/contracts";
import type { ExecutableToolCall } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";
import type { BackgroundTaskSnapshot } from "./background-task-lifecycle.js";
import { isRecord } from "./utils.js";
import { formatTaskNotification } from "../../runtime-task/notification.js";
import {
  claimRuntimeBackgroundTaskNotification,
  isDynamicWorkflowRunDispatchToolName,
  releaseRuntimeBackgroundTaskNotification,
} from "./background-task-registry.js";
import { backgroundTaskOutputMetadata } from "./background-task-output.js";
import {
  formatWorkflowTaskNotification,
  buildWorkflowNotificationOriginMeta,
} from "./workflow-task-notification.js";
import {
  normalizeBackgroundTaskNotificationStatus,
  stringField,
  workflowSnapshotTerminal,
  type BashTaskNotificationStatus,
} from "./workflow-task-snapshot.js";

export function maybeEnqueueBackgroundTaskNotification(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  taskId: string,
  status: string,
  snapshot: BackgroundTaskSnapshot | undefined,
  traceContext: TraceContext,
  output?: Record<string, unknown>,
): void {
  if (!deps.enqueueBackgroundTaskNotification) {
    deps.logger?.debug?.("Background task notification queue unavailable", {
      ...traceContextToLogContext(traceContext),
      event: "background_task.notification.queue_unavailable",
      module: "core.tool.executor",
      taskId,
      taskStatus: status,
      toolName: toolCall.name,
    });
    return;
  }

  // 被修订替代的 run 不发终态通知：
  // 停下它的那次 AmendWorkflow 的工具结果就是模型对这次停止的
  // 全部所知，再来一条「你停了 run A，现在去修订它」会把模型送进循环。仍然 claim：让稍后的
  // TaskOutput 读取不把它当成一条没送达的通知。
  if (workflowSnapshotTerminal(status, snapshot)?.stopReason === "superseded") {
    claimRuntimeBackgroundTaskNotification(deps, toolCall, taskId);
    deps.logger?.info?.("Background task notification suppressed: run superseded", {
      ...traceContextToLogContext(traceContext),
      event: "background_task.notification.suppressed",
      module: "core.tool.executor",
      reason: "workflow_run_superseded",
      taskId,
      taskStatus: status,
      toolName: toolCall.name,
    });
    return;
  }

  if (
    deps.shouldEnqueueBackgroundTaskNotification?.({
      runtimeScope: deps.runtimeScope,
      status,
      taskId,
      toolName: toolCall.name,
      traceContext,
    }) === false
  ) {
    deps.logger?.info?.("Background task notification suppressed by runtime policy", {
      ...traceContextToLogContext(traceContext),
      event: "background_task.notification.suppressed",
      module: "core.tool.executor",
      taskId,
      taskStatus: status,
      toolName: toolCall.name,
    });
    return;
  }

  const text = formatBackgroundTaskNotification(deps, toolCall, taskId, status, snapshot, output);
  if (!text) {
    deps.logger?.debug?.("Background task notification skipped without formatted message", {
      ...traceContextToLogContext(traceContext),
      event: "background_task.notification.skipped",
      module: "core.tool.executor",
      reason: "empty_message",
      taskId,
      taskStatus: status,
      toolName: toolCall.name,
    });
    return;
  }
  // TaskOutput 读取终态会先把同一 registry task 标成 notified；
  // completion 只有成功 claim 后才能入队，避免模型同时收到 tool result 和重复通知。
  if (!claimRuntimeBackgroundTaskNotification(deps, toolCall, taskId)) {
    deps.logger?.debug?.("Background task notification already claimed", {
      ...traceContextToLogContext(traceContext),
      event: "background_task.tracking.notification_already_handled",
      module: "core.tool.executor",
      taskId,
      taskStatus: status,
      toolName: toolCall.name,
    });
    return;
  }
  try {
    deps.enqueueBackgroundTaskNotification({
      ...(toolCall.name === "Bash"
        ? {
            originMeta: {
              backgroundSource: "bash" as const,
              title: resolveBashBackgroundResultTitle(toolCall, taskId),
              workId: taskId,
            },
          }
        : {}),
      // workflow run 的终态回合要渲染成后台结果头，而不是退化成一条裸 model-only 消息，
      // 所以 originMeta 必须带上（workId ≡ runId）。CreateWorkflow 与 ResumeWorkflowRun
      // 两个入口同构（分派见 isDynamicWorkflowRunDispatchToolName）。manifest 载荷
      // （workflowNotification）在此处发射侧铸造：GUI 渲染的唯一数据源，随 originMeta 走全管线。
      ...(isDynamicWorkflowRunDispatchToolName(toolCall.name)
        ? {
            originMeta: buildWorkflowNotificationOriginMeta(
              toolCall,
              taskId,
              status,
              snapshot,
              output,
            ),
          }
        : {}),
      taskId,
      text,
      toolName: toolCall.name,
      traceContext,
    });
  } catch (error) {
    releaseRuntimeBackgroundTaskNotification(deps, toolCall, taskId);
    deps.logger?.warn("Background task notification enqueue failed", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      module: "core.tool.executor",
      taskId,
    });
    return;
  }
  deps.logger?.info?.("Background task notification enqueued", {
    ...traceContextToLogContext(traceContext),
    event: "background_task.notification.enqueued",
    module: "core.tool.executor",
    taskId,
    taskStatus: status,
    toolName: toolCall.name,
  });
}

export function formatBackgroundTaskNotification(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  taskId: string,
  status: string,
  snapshot: BackgroundTaskSnapshot | undefined,
  output?: Record<string, unknown>,
): string | undefined {
  // workflow run 复用 legacy Workflow 的通知格式（复用 formatWorkflowTaskNotification）。
  // legacy "Workflow" 保持独立并列：它没有 dwf 的产物/reports 语义，只在共享格式器里
  // 走自己的 output.response 回退分支。
  if (toolCall.name === "Workflow" || isDynamicWorkflowRunDispatchToolName(toolCall.name)) {
    return formatWorkflowTaskNotification(deps, toolCall, taskId, status, snapshot, output);
  }
  if (toolCall.name !== "Bash") return undefined;

  const input = isRecord(toolCall.input) ? toolCall.input : {};
  const command = typeof input.command === "string" ? input.command : undefined;
  const description = typeof input.description === "string" ? input.description : undefined;
  const result = snapshot && "result" in snapshot ? snapshot.result : undefined;
  const outputMetadata = backgroundTaskOutputMetadata(snapshot, output);
  const notificationStatus = normalizeBackgroundTaskNotificationStatus(status);
  const summary = buildBackgroundTaskSummary({
    command,
    description,
    exitCode: result?.exitCode,
    lost: status === "lost",
    status: notificationStatus,
  });
  return formatTaskNotification({
    description,
    outputFile: outputMetadata.outputFile,
    status: notificationStatus,
    summary,
    taskId,
    taskType: "local_bash",
    toolUseId: toolCall.id,
  });
}

function resolveBashBackgroundResultTitle(toolCall: ExecutableToolCall, taskId: string): string {
  const input = isRecord(toolCall.input) ? toolCall.input : {};
  const description = stringField(input, "description")?.trim();
  const command = stringField(input, "command")?.trim();
  return description || command || toolCall.name || taskId;
}

function buildBackgroundTaskSummary(input: {
  command?: string;
  description?: string;
  exitCode?: number;
  lost?: boolean;
  status: BashTaskNotificationStatus;
}): string {
  const subject = input.description ?? input.command ?? "Bash background command";
  const prefix = `Background command "${subject}"`;
  // Provider-visible summary 保持简洁；完整输出路径由 task-notification 的 output-file 字段承载。
  if (input.lost) return `${prefix} failed because its in-process state was lost`;
  switch (input.status) {
    case "completed":
      return `${prefix} completed${input.exitCode !== undefined ? ` (exit code ${input.exitCode})` : ""}`;
    case "failed":
      return `${prefix} failed${input.exitCode !== undefined ? ` with exit code ${input.exitCode}` : ""}`;
    case "killed":
      return `${prefix} was stopped`;
  }
}
