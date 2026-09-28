// ============================================================
// Workflow run 内省工具的共同面（ListWorkflowRuns / GetWorkflowRun）
// ============================================================
//
// 三样东西必须逐字共用，所以它们在这里而不是在两个 handler 里各写一遍：
//
//   1. **能力缺席的业务失败**。「端口缺席」（journal 不可用 → run service 整个不构造）与
//      「端口在场但方法缺席」（journal 不带内省查询）对模型是同一件事：本会话没有这个能力。
//      两个工具、两条判据，一段文案。
//   2. **失败码**。`ToolHandlerFailure.errorCode` 的类型是 number（executor 侧的
//      `isToolHandlerFailure` 按 number 收），所以两个稳定判别键
//      （`workflow_introspection_unavailable` / `run_not_found`）落在 message 的前缀上——
//      它是模型与日志唯一能读到的判别位。
//   3. **异步引导文案**。两个工具描述都要说清「本会话的 run 会自动送达携产物的通知」，
//      文案分叉就等于给模型两套默认行为。

import { escapeXml } from "../../runtime-task/notification.js";
import type { ToolHandlerFailure } from "../types.js";

/**
 * 业务失败码。数值本身不进模型（executor 把它投影成 `code: "1"`），判别键在 message 前缀。
 * 两个码必须不同：能力缺席与 run 未知是模型要分别处理的两件事。
 */
const WORKFLOW_RUN_INTROSPECTION_ERROR_CODE = {
  INTROSPECTION_UNAVAILABLE: 1,
  RUN_NOT_FOUND: 2,
} as const;

/**
 * 「本会话没有 workflow 内省能力」。**绝不**静默回空列表：那会让模型把「这个项目没跑过
 * workflow」和「这个会话读不到 workflow」混成同一个结论（CreateWorkflow 的可见降级同款理由）。
 */
export function workflowIntrospectionUnavailableFailure(): ToolHandlerFailure {
  return {
    result: false,
    errorCode: WORKFLOW_RUN_INTROSPECTION_ERROR_CODE.INTROSPECTION_UNAVAILABLE,
    message:
      "workflow_introspection_unavailable: this session cannot read workflow runs — workflow execution is not available here, so no run history is reachable. This is a capability gap, not an empty project.",
  };
}

export function workflowRunNotFoundFailure(runId: string): ToolHandlerFailure {
  return {
    result: false,
    errorCode: WORKFLOW_RUN_INTROSPECTION_ERROR_CODE.RUN_NOT_FOUND,
    message: `run_not_found: no workflow run with ID ${runId} exists for this project. Use ListWorkflowRuns to see the runs that do.`,
  };
}

/**
 * 两个工具描述共用的异步引导。
 *
 * 不禁用轮询——用户显式要求盯着在飞 run 时它仍是对的动作；这里只设默认。
 */
export const WORKFLOW_RUN_INTROSPECTION_STEERING = [
  "Runs this session starts settle on their own: you receive a completion notification carrying the final output. Do NOT poll this tool while waiting for one — continue with other work.",
  "Reach for it when: (a) the user asks how a workflow is going, (b) you want to review this project's earlier runs, including ones other sessions started, (c) a completion notification was truncated and you need the run's full record by ID.",
].join("\n");

/**
 * epoch ms → ISO 8601（UTC）。结构化输出里时间戳是 epoch ms（journal 的原样事实），模型面给
 * ISO：那是它能直接读出「多久以前」的形式，而不必对一串 13 位数字做心算。
 *
 * 坏值（NaN / 越界）落回原始数字而不是抛错——一条时间戳不该让整个工具结果失败。
 */
export function formatWorkflowRunTimestamp(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return String(epochMs);
  try {
    return new Date(epochMs).toISOString();
  } catch {
    return String(epochMs);
  }
}

/** 时长阶梯。一处定义，摘要与格式器共用——两处各写一套就会在某次调参时分叉。 */
const DURATION_MS = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
} as const;

function padTwo(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * 毫秒 → 人读的时长（`40s` / `5m 10s` / `2h 15m` / `3d 2h`）。
 *
 * 只保留两级：一个读者要的是量级而不是精度，而「1h 02m 03s」会让他去数位数。分与秒补零
 * （同为 60 进制的子单位，不补零时 `1m 5s` 与 `1m 50s` 一眼难分），日下的小时不补。
 * 非有限值与负值（时钟回拨）折成 0，绝不让一条时间戳把整个工具结果变成 NaN。
 */
export function formatWorkflowRunDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (total < DURATION_MS.minute) return `${Math.floor(total / DURATION_MS.second)}s`;
  if (total < DURATION_MS.hour) {
    const minutes = Math.floor(total / DURATION_MS.minute);
    const seconds = Math.floor((total % DURATION_MS.minute) / DURATION_MS.second);
    return `${minutes}m ${padTwo(seconds)}s`;
  }
  if (total < DURATION_MS.day) {
    const hours = Math.floor(total / DURATION_MS.hour);
    const minutes = Math.floor((total % DURATION_MS.hour) / DURATION_MS.minute);
    return `${hours}h ${padTwo(minutes)}m`;
  }
  const days = Math.floor(total / DURATION_MS.day);
  const hours = Math.floor((total % DURATION_MS.day) / DURATION_MS.hour);
  return `${days}d ${hours}h`;
}

/**
 * 「多久以前」。`at` 缺席或不是有限数时回 `undefined`——读侧据此**整段省略**这个年龄，
 * 而不是渲染一个 0 或「unknown」：没有时间戳的老 journal 说不出年龄，这是一件事实。
 */
export function formatRelativeAge(now: number, at: number | undefined): string | undefined {
  if (at === undefined || !Number.isFinite(at) || !Number.isFinite(now)) return undefined;
  return `${formatWorkflowRunDuration(now - at)} ago`;
}

/** 格式化 ISO 时刻与相对年龄；年龄不可知时只显示 ISO 时刻。 */
export function formatWorkflowRunInstant(now: number, at: number): string {
  const age = formatRelativeAge(now, at);
  const iso = formatWorkflowRunTimestamp(at);
  return age === undefined ? iso : `${iso} (${age})`;
}

/**
 * 千分位。`toLocaleString` 的结果取决于宿主的 ICU 数据，而模型面的每一个字都要能被测试
 * 逐字钉住，所以这里自己插逗号。
 */
export function formatWorkflowRunCount(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const sign = value < 0 ? "-" : "";
  const digits = String(Math.trunc(Math.abs(value)));
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

/**
 * XML-ish 属性。值先把空白折成单空格再转义：属性里的换行会破坏「一 run 一行」的排版，
 * 而 label 是自由文本（用户起的名字或脚本首行）。
 */
export function workflowRunAttribute(name: string, value: string | number | boolean): string {
  const text = typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : String(value);
  return `${name}="${escapeXml(text)}"`;
}

/**
 * 转义**复用** runtime-task 的通知投影里那一个（notification.ts）：两处是同一类
 * XML-ish 模型面投影，而一张抄第二遍的转义表只会在某次调整时分叉。
 */
export { escapeXml as escapeWorkflowRunText };
