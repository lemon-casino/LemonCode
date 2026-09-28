// ============================================================
// workflow run 的后台停止分支（runtime.stopBackgroundTask 的 local_dynamic_workflow 分派）
// ============================================================
//
// 这是**唯一一条取消路径**的末端。两个入口汇到同一个实现：
//   1. GUI：v4 `cancelBackgroundWork {workId}` → `app.cancelBackgroundTask`
//      → `runtime.cancelBackgroundTask` → `runtime.stopBackgroundTask`（lenient）
//   2. 模型：`TaskStop` 工具 → `backgroundTaskControlPort.stopBackgroundTask`
//      （runtime-tools.ts 把它绑定到同一个 `runtime.stopBackgroundTask`，strict: true）
// 两者只在 strict 上不同（strict 让已终结的任务返回 not_running 而不是宽松的成功），
// 分派与本模块之后的行为完全一致——不存在第二条 cancel 语义。
//
// 单独成模块是为了限制 background.ts 的规模，避免继续增加分支复杂度。
// background.ts 侧只保留一个 import 与一行分派。

import type { AgentRuntimeInternal } from "../internal.js";
import type {
  RuntimeBackgroundStopInitiator,
  RuntimeBackgroundStopResult,
  TypedRuntimeBackgroundStopTarget,
} from "./background-stop-types.js";

/**
 * 停止一个 workflow run：把 taskId（≡ runId ≡ workId，无身份映射表）交给
 * `DynamicWorkflowRunPort.cancel`。
 *
 * 端口内部 abort 注册表里的 AbortController：中止在飞 ask、kill 沙箱子进程，并让引擎经
 * `stop(initiator)` 把 run 结算成 `stopped(user | model)`（**不是** `errored`——journal 是 app
 * 读的持久记录，两个状态的语义与 resume UX 都不同，harness 绝不把失败编码成停止）。
 *
 * 两种降级都返回结构化结果而不是假装成功：
 *   - 端口整个缺席（未接线的宿主）→ 能力不支持；
 *   - 端口对未知/已结算的 run 回 false → not_found。
 */
export async function stopDynamicWorkflowBackgroundTask(
  this: AgentRuntimeInternal,
  target: TypedRuntimeBackgroundStopTarget,
  unsupported: (target: TypedRuntimeBackgroundStopTarget) => RuntimeBackgroundStopResult,
  initiator?: RuntimeBackgroundStopInitiator,
): Promise<RuntimeBackgroundStopResult> {
  const port = this.dynamicWorkflowRunPort;
  if (!port) {
    return unsupported(target);
  }
  // 先记「是谁停的」再 abort：终态通知是稍后 waiter 结算时铸造的，registry 条目是两者之间
  // 唯一的共享状态。写在 abort 之前，
  // 否则结算可能抢先一步读到空值。
  if (initiator !== undefined && target.registryTask !== undefined) {
    this.runtimeTaskRegistry.update(target.taskId, (current) => ({
      ...current,
      stopInitiator: initiator,
    }));
  }
  // 原因随 cancel 落库：run 结算成 `stopped(user|model)`，
  // 终态通知与 GetWorkflowRun 从 journal 读到「谁停的」，而不再只靠上面那条 registry 兜底。
  // 用户亲手停下的事实也是 AmendWorkflow 免确认规则读的那一位：用户刚表达了「停下」，模型接着修订就该重新问。
  const cancelled = await port.cancel(target.taskId, initiator);
  if (!cancelled) {
    return {
      ok: false,
      reason: "background_task_not_found",
      status: "lost",
      taskId: target.taskId,
      type: "local_dynamic_workflow",
    };
  }
  return {
    ok: true,
    status: "cancelled",
    taskId: target.taskId,
    type: "local_dynamic_workflow",
  };
}
