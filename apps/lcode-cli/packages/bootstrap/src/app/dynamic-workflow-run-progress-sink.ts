/**
 * workflow run 进度事件 → 父会话的追加汇（create-app 的 `onRunEvent` 就是它）。
 *
 * 单独成文件而不是留在 create-app 的闭包里，是为了让下面三条**降级路径**可被直接单测：
 * 它们都属于「run 在飞、观察面出问题」这一类，任何一条把异常放出去都会打挂一个正在跑的 run，
 * 而 run 的真相在 journal——进度面只是观察面，绝不该有能力终止它。
 */

import type { DynamicWorkflowRunProgressPayload, Logger, SessionId } from "@lcode/contracts";
import type { AgentRuntime } from "@lcode/core";

interface DynamicWorkflowRunProgressSinkDeps {
  /** 惰性取 runtime：run service 在 runtime 构造**之前**就已建好（它是 runtime 的依赖之一）。 */
  getRuntime: () => AgentRuntime;
  /** 本 app 所属会话。run 的 parentSessionId 必须与它相等，见下面的身份闸门。 */
  sessionId: SessionId;
  logger?: Logger;
}

/**
 * 造一个进度汇。返回的函数**永不抛异常、永不返回 rejected promise**。
 *
 * ## 身份闸门（load-bearing）
 *
 * 事件必须落在**发起该 run 的那个会话**里。今天这是按构造成立的 1:1：
 *
 *   LCodeApp ──1:1── AgentRuntime ──1:1── sessionId        （create-app：`new AgentRuntime(sessionId, …)`）
 *        └──1:1── run service（本 app 内建，端口不外借）
 *   CreateWorkflow handler 提交时带 `parentSessionId = context.sessionId`
 *
 * 而**只有** app 顶层 runtime 能拿到 `dynamicWorkflowRunPort`：subagent 子 runtime 的依赖对象
 * （`core/src/runtime/methods/subagent.ts` 的 `new AgentRuntime(...)`）与 workflow actor runtime
 * （`script-workflow-child-runtime.ts`）都**不含**该端口（已逐字核对），所以子会话根本走不到
 * submit——它们的 CreateWorkflow 落回「端口缺席 → 占位诊断」那条路。
 *
 * 于是 `getRuntime()` 就是正确的那个 runtime。**但这条不变式不写下来就会被将来的人改掉**：
 * 只要有人把该端口加进子 runtime 的依赖，子会话发起的 run 就会把事件投进**父**会话的
 * transcript——一个不会报错、只会让事件出现在错误对话里的 bug。所以这里显式比对身份，
 * 不相等时**不追加**并记一条带指引的日志：宁可少一份投影，也不要污染另一个会话的 transcript。
 * （真要支持子会话发起 run，需要的是按 sessionId 找 runtime 的注册表，而 bootstrap 侧没有——
 * 子 runtime 活在 core 内部。那是一次带自己的设计的改动。）
 */
export function createDynamicWorkflowRunProgressSink(
  deps: DynamicWorkflowRunProgressSinkDeps,
): (progress: DynamicWorkflowRunProgressPayload, routing?: { parentSessionId?: string }) => void {
  const warn = (message: string, runId: string, extra: Record<string, unknown> = {}): void => {
    deps.logger?.warn?.(message, {
      event: "dynamic_workflow.run_progress.append_failed",
      module: "bootstrap.app",
      runId,
      ...extra,
    });
  };

  return (progress, routing) => {
    const parentSessionId = routing?.parentSessionId;
    // 缺席是合法的（submit 未带 parentSessionId）：本 app 的端口只可能被本会话触达，
    // 所以缺席等价于"就是本会话"。只有**明确不等**才是接线错误。
    if (parentSessionId !== undefined && parentSessionId !== deps.sessionId) {
      warn("Dynamic workflow run progress dropped: parent session is not this app", progress.runId, {
        event: "dynamic_workflow.run_progress.session_mismatch",
        expectedSessionId: deps.sessionId,
        parentSessionId,
        reason: "run_parent_session_not_owned_by_this_app",
      });
      return;
    }

    // getRuntime() 在 runtime 尚未构造时**同步抛错**；关闭中的 runtime 也可能在 append 链路
    // （事件库 / 持久化 / sink 扇出）上抛。两者都必须退化成"记一条日志的 no-op"。
    let appended: Promise<void>;
    try {
      appended = deps.getRuntime().recordDynamicWorkflowRunProgress(progress);
    } catch (error) {
      warn("Dynamic workflow run progress append failed", progress.runId, {
        errorMessage: error instanceof Error ? error.message : String(error),
        reason: "runtime_unavailable",
      });
      return;
    }
    void appended.catch((error: unknown) => {
      warn("Dynamic workflow run progress append failed", progress.runId, {
        errorMessage: error instanceof Error ? error.message : String(error),
        reason: "append_rejected",
      });
    });
  };
}
