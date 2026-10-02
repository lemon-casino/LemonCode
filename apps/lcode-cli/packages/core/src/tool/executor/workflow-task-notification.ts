import type {
  BackgroundResultOriginMeta,
  DynamicWorkflowRunStopReason,
  WorkflowNotificationMeta,
} from "@lcode/contracts";
import type { ExecutableToolCall } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";
import type { BackgroundTaskSnapshot } from "./background-task-lifecycle.js";
import { isRecord } from "./utils.js";
import { formatTaskNotification } from "../../runtime-task/notification.js";
import { describeWorkflowScriptPath } from "../handlers/workflow-script-path.js";
import { isDynamicWorkflowRunDispatchToolName } from "./background-task-registry.js";
import {
  buildWorkflowReportsManifestSection,
  buildWorkflowReportsNotificationSection,
  serializeWorkflowArtifact,
} from "./workflow-artifact.js";
import {
  buildWorkflowArtifactsManifestSection,
  buildWorkflowArtifactsNotificationSection,
  WORKFLOW_ARTIFACTS_NOTIFICATION_MAX_LINES,
} from "./workflow-published-artifacts.js";
import {
  normalizeBackgroundTaskNotificationStatus,
  runtimeString,
  stringField,
  workflowSnapshotArtifacts,
  workflowSnapshotReports,
  workflowSnapshotScriptPath,
  workflowSnapshotTerminal,
  workflowTaskSubject,
  type BashTaskNotificationStatus,
  type WorkflowTerminalRunStatus,
} from "./workflow-task-snapshot.js";

export function formatWorkflowTaskNotification(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  taskId: string,
  status: string,
  snapshot: BackgroundTaskSnapshot | undefined,
  launchOutput?: Record<string, unknown>,
): string {
  const output =
    snapshot && "output" in snapshot && isRecord(snapshot.output) ? snapshot.output : launchOutput;
  const subject = workflowTaskSubject(toolCall, taskId, snapshot, output);
  const notificationStatus = normalizeBackgroundTaskNotificationStatus(status);
  // dwf 的三终态词与停止原因从快照读：run service 把
  // journal 里的 `stopReason` 投影到 `snapshot.stopReason`，所以「谁停的」不再只活在 registry。
  // registry 的 stopInitiator 只作兼容兜底（老端口 / stub 不发 stopReason 时）。
  const terminal = workflowSnapshotTerminal(status, snapshot);
  const stopReason =
    terminal?.stopReason ??
    (status === "cancelled" ? deps.runtimeTaskRegistry?.get(taskId)?.stopInitiator : undefined);
  const summary = buildWorkflowTaskSummary({
    lost: status === "lost",
    status: notificationStatus,
    runStatus: terminal?.runStatus,
    stopReason,
    subject,
  });
  // dwf 与 legacy `Workflow` 在**结果**这一项上分道：
  //   - dwf 的产物是脚本的任意顶层返回值，取 `snapshot.output` 原值并统一序列化，且**绝不**
  //     回退到 launch output——后者的 `response` 是「run 已在后台启动」的陈旧散文，
  //     回退过去比缺席更糟（桌面实测 bug 的第二种表现）。
  //   - legacy `Workflow` 的 `output.response` 真实存在，launchOutput 回退是它自己的契约，
  //     逐字节保留。
  // subject 仍走上面那个 record 门控的 output（展示名不涉及产物形状）。
  // dwf 分派名扩到 ResumeWorkflowRun：恢复的 run 与新启动的 run 在通知形状上同构。
  const result = isDynamicWorkflowRunDispatchToolName(toolCall.name)
    ? serializeWorkflowArtifact(snapshot && "output" in snapshot ? snapshot.output : undefined)
    : stringField(output, "response");
  // 渐进产物（`report(item)`）只属于 dwf：legacy `Workflow` 没有这个概念，它的通知逐字节不变。
  // **三个终态一律携带**（completed / failed / cancelled）：一个死在第 12 个 ask 上的 run
  // 仍然做完了 11 个 ask 的活，只报一句「失败」等于把它全扔了——那正是 report 存在的理由。
  // 条目来自 journal 的 kind="report" 行（run service 放在快照上），不是 memory-only 的投影。
  const isDynamicWorkflow = isDynamicWorkflowRunDispatchToolName(toolCall.name);
  const reports = isDynamicWorkflow
    ? buildWorkflowReportsNotificationSection(workflowSnapshotReports(snapshot))
    : undefined;
  // 用户面产物同样只属于 dwf（legacy `Workflow` 没有这个概念，通知逐字节不变）。三个终态
  // 一律携带：一个失败的 run 已经发布的产物仍然摆在用户面前，通知不提它，模型就会重述一遍。
  const artifacts = isDynamicWorkflow
    ? buildWorkflowArtifactsNotificationSection(
        workflowSnapshotArtifacts(snapshot),
        WORKFLOW_ARTIFACTS_NOTIFICATION_MAX_LINES,
      )
    : undefined;
  // 脚本文件同样只属于 dwf：呈现指引据它把
  // 下一步说成「就地编辑那个文件」。journal 存的是绝对路径，模型面给工作区相对写法——
  // 它接下来要 Edit 这个文件，而那正是它在别处读写文件时用的那一种路径。
  const scriptPath = isDynamicWorkflow ? workflowSnapshotScriptPath(snapshot) : undefined;
  return formatTaskNotification({
    description: subject,
    // 交付物呈现指引同样只属于 dwf。
    ...(isDynamicWorkflow ? { deliveryGuidance: true } : {}),
    ...(scriptPath === undefined
      ? {}
      : { scriptPath: describeWorkflowScriptPath(scriptPath, deps.getWorkingDirectory()) }),
    error: snapshot && "error" in snapshot ? runtimeString(snapshot.error) : undefined,
    ...(reports === undefined ? {} : { reports }),
    ...(artifacts === undefined ? {} : { artifacts }),
    result,
    status: notificationStatus,
    ...(terminal?.runStatus === undefined ? {} : { runStatus: terminal.runStatus }),
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(terminal?.failure === undefined ? {} : { failure: terminal.failure }),
    summary,
    taskId,
    taskType: "local_workflow",
    toolUseId: toolCall.id,
  });
}

function buildWorkflowTaskSummary(input: {
  lost?: boolean;
  status: BashTaskNotificationStatus;
  runStatus?: WorkflowTerminalRunStatus;
  stopReason?: DynamicWorkflowRunStopReason | undefined;
  subject: string;
}): string {
  const prefix = `Workflow "${input.subject}"`;
  if (input.lost) return `${prefix} failed because its in-process state was lost.`;
  // 一句话就要把「怎么结束的」说清：模型读 summary 比读 XML 字段更早。dwf 的三终态词优先；
  // legacy `Workflow` 不带 runStatus，落回追踪器的通用词。
  if (input.runStatus === "errored") return `${prefix} errored: the script failed.`;
  if (input.runStatus === "stopped" || input.status === "killed") {
    switch (input.stopReason) {
      case "user":
        return `${prefix} was stopped by the user.`;
      case "model":
        return `${prefix} was stopped by you (TaskStop).`;
      case "provider":
        return `${prefix} was stopped on a provider error.`;
      case "interrupted":
        return `${prefix} was stopped: the process that owned it exited.`;
      case "superseded":
        return `${prefix} was stopped and superseded by an amended run.`;
      default:
        return `${prefix} was stopped.`;
    }
  }
  return input.status === "completed" ? `${prefix} completed.` : `${prefix} failed.`;
}

/** manifest 载荷（`WorkflowNotificationMeta`）里各字段的界。发射侧就地截断——载荷随 turnHeader
 *  row 走协议 + snapshot，shared 的 `workflowNotificationMetaSchema` 用同一组 `.max()` 把关，
 *  超界会让整行落库时 zod 拒收。所以截断是**构造前**的纪律，不是可有可无的收尾。 */
const WORKFLOW_NOTIFICATION_SUMMARY_MAX_CHARS = 500;
const WORKFLOW_NOTIFICATION_RESULT_MAX_CHARS = 4_000;
const WORKFLOW_NOTIFICATION_ERROR_MAX_CHARS = 2_000;

/**
 * workflow run 终态通知的 workflow originMeta（含 manifest 载荷）。CreateWorkflow / ResumeWorkflowRun
 * 两个入口同构，都经这里铸造：title 与 summary 同源（`workflowTaskSubject`），载荷只在**终态且
 * 快照在场**时携带（非终态 / lost 无快照 → 整字段缺席，GUI 退回裸标题行）。
 */
export function buildWorkflowNotificationOriginMeta(
  toolCall: ExecutableToolCall,
  taskId: string,
  status: string,
  snapshot: BackgroundTaskSnapshot | undefined,
  output: Record<string, unknown> | undefined,
): BackgroundResultOriginMeta {
  const subject = workflowTaskSubject(toolCall, taskId, snapshot, output);
  const workflowNotification = buildWorkflowTerminalNotification(status, subject, snapshot);
  return {
    backgroundSource: "workflow",
    title: subject,
    workId: taskId,
    ...(workflowNotification ? { workflowNotification } : {}),
  };
}

/**
 * 快照级事实 → terminal 判别分支的 manifest 载荷。
 *
 * 只在三个终态（completed / failed / cancelled）且快照在场时铸造。`lost`（快照缺失）与非终态
 * 一律回 `undefined`——载荷缺席即 GUI 退回现状标题行，而不是谎报一个空壳。**usage/tokens 发射
 * 时不可知**（只在内存态投影里），所以只带 durationMs，tokens 留给 GUI 渲染期按 runId 联查。
 */
function buildWorkflowTerminalNotification(
  status: string,
  summary: string,
  snapshot: BackgroundTaskSnapshot | undefined,
): WorkflowNotificationMeta | undefined {
  const terminalStatus = workflowTerminalNotificationStatus(status);
  if (terminalStatus === undefined || snapshot === undefined) return undefined;

  const terminal = workflowSnapshotTerminal(status, snapshot);
  const meta: Extract<WorkflowNotificationMeta, { kind: "terminal" }> = {
    kind: "terminal",
    status: terminal?.runStatus ?? terminalStatus,
    ...(terminal?.stopReason === undefined ? {} : { stopReason: terminal.stopReason }),
    summary: summary.slice(0, WORKFLOW_NOTIFICATION_SUMMARY_MAX_CHARS),
  };

  // 产物：脚本的任意顶层返回值，统一序列化。截断诚实——`resultTruncated` 在场即预览是局部的，
  // 全量经 run id / GetWorkflowRun 可取。resultForm 与 serializeWorkflowArtifact 的分叉对齐：
  // string 原样（prose），其余 JSON.stringify（json）。
  const outputValue = snapshot && "output" in snapshot ? snapshot.output : undefined;
  const serialized = serializeWorkflowArtifact(outputValue);
  if (serialized !== undefined) {
    if (serialized.length > WORKFLOW_NOTIFICATION_RESULT_MAX_CHARS) {
      meta.result = serialized.slice(0, WORKFLOW_NOTIFICATION_RESULT_MAX_CHARS);
      meta.resultTruncated = true;
    } else {
      meta.result = serialized;
    }
    meta.resultForm = typeof outputValue === "string" ? "prose" : "json";
  }

  const error = snapshot && "error" in snapshot ? runtimeString(snapshot.error) : undefined;
  if (error !== undefined) meta.error = error.slice(0, WORKFLOW_NOTIFICATION_ERROR_MAX_CHARS);

  // 渐进产物三个终态一律携带：一个死在第 12 个 ask 上的 run 仍做完了 11 个 ask 的活。
  const reports = buildWorkflowReportsManifestSection(workflowSnapshotReports(snapshot));
  if (reports !== undefined) meta.reports = reports;

  // 用户面产物的 chips 载荷。这是通知行 chips 的
  // **唯一**数据源：hydration 冷恢复把它按 shared 的 zod 原样读回，缺一个键就等于 chips 永久
  // 消失。三个终态一律携带，理由同 reports。
  const artifactsSection = buildWorkflowArtifactsManifestSection(
    workflowSnapshotArtifacts(snapshot),
  );
  if (artifactsSection !== undefined) {
    meta.artifacts = artifactsSection.artifacts;
    if (artifactsSection.artifactsTruncated) meta.artifactsTruncated = true;
  }

  const durationMs = workflowNotificationDurationMs(snapshot);
  if (durationMs !== undefined) meta.durationMs = durationMs;

  return meta;
}

/**
 * 追踪器终态 status → manifest 的三个终态字面（`failed` → errored、`cancelled` → stopped）；非终态（running / lost 等）回 undefined（不携带
 * 载荷）。快照自带 `runStatus` 时以它为准（见 workflowSnapshotTerminal）。
 */
function workflowTerminalNotificationStatus(
  status: string,
): "completed" | "errored" | "stopped" | undefined {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "errored";
    case "cancelled":
      return "stopped";
    default:
      return undefined;
  }
}

/** `completedAt - startedAt`，两者齐备且差为非负有限数才置（否则整字段缺席）。 */
function workflowNotificationDurationMs(snapshot: BackgroundTaskSnapshot): number | undefined {
  const startedAt =
    "startedAt" in snapshot && snapshot.startedAt instanceof Date
      ? snapshot.startedAt.getTime()
      : undefined;
  const completedAt =
    "completedAt" in snapshot && snapshot.completedAt instanceof Date
      ? snapshot.completedAt.getTime()
      : undefined;
  if (startedAt === undefined || completedAt === undefined) return undefined;
  const durationMs = completedAt - startedAt;
  return Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : undefined;
}
