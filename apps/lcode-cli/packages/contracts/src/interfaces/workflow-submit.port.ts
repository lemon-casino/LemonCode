// ============================================================
// Workflow Submit Port - actor terminal-result verdict boundary
// ============================================================

import type { TraceContext } from "../tracing/tracer.js";
import type { ToolCallId } from "./shared.js";

/**
 * 校验器产出的单条违规，设计成可直接进入修复用的 tool_result：一行一条，包含
 * JSON 路径、期望（expected）与实得（got）。
 *
 * 结构与 dynamic-workflow 合成侧的 Violation 一致；driver 负责把引擎
 * 的 Violation 原样映射到本端口，contracts 不反向依赖 dynamic-workflow。
 */
export interface SubmitViolation {
  /** 违规所在位置的 JSON 路径，形如 `$`、`$.foo`、`$.items[0]`。 */
  path: string;
  /** 期望的形状/取值的简短描述。 */
  expected: string;
  /** 实际取到的值的简短描述。 */
  got: string;
}

export interface SubmitResultRequest {
  /** 发起 submit_result 调用的 actor 子会话内的 tool call id。 */
  toolCallId: ToolCallId | string;
  /** 模型提交的原始结构化结果（未经本端口校验的任意 JSON）。 */
  result: unknown;
  trace: TraceContext;
}

/** 引擎接受本次提交：actor turn 应当在结果返回后终止。 */
export interface SubmitAccepted {
  accept: true;
}

/** 引擎拒绝本次提交：返回违规列表供模型在同一会话内修复重试。 */
export interface SubmitRejected {
  accept: false;
  violations: readonly SubmitViolation[];
}

export type SubmitVerdict = SubmitAccepted | SubmitRejected;

export interface WorkflowSubmitPort {
  /**
   * 提交 actor 的结构化终态结果并等待引擎裁决。
   *
   * 与 CoordinatorResponsePort 不同，这里 **阻塞** 直到引擎完成校验：引擎可能在带外
   * 跑多轮修复/预算判定，因此 resolve 可能耗时任意长。取消不由本端口表达——由中止
   * 该 tool call（abort）来处理，driver 会把带外的 ask 取消转成 turn abort。
   *
   * 路由身份（instance/actor/session）由端口 closure 绑定，模型无法覆盖。
   */
  respond(request: SubmitResultRequest): Promise<SubmitVerdict>;
}
