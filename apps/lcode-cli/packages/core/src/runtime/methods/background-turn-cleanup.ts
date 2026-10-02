import { traceContextToLogContext } from "../deps.js";
import type { TraceContext, TurnId } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

/** Settle only Bash processes owned by this successful turn before publishing TurnComplete. */
export async function cleanupTurnBackgroundBash(
  runtime: AgentRuntimeInternal,
  turnId: TurnId,
  traceContext: TraceContext,
): Promise<void> {
  const tasks = Object.values(runtime.runtimeTaskRegistry.all()).filter(
    (task) =>
      task.type === "local_bash" &&
      task.isBackgrounded === true &&
      task.status === "running" &&
      task.turnId === turnId &&
      task.keepAliveAfterTask !== true,
  );
  await Promise.all(
    tasks.map(async (task) => {
      // 完成轮的系统取消不是新的用户输入；先标记再请求停止，避免终态通知竞态唤醒模型。
      runtime.runtimeTaskRegistry.update(task.taskId, (current) => ({
        ...current,
        cleanupOnTurnComplete: true,
      }));
      try {
        const stopped = await runtime.stopBackgroundTask(task.taskId, { traceContext });
        if (!stopped.ok) {
          runtime.logger?.warn("Turn-bound Bash cleanup could not stop process", {
            ...traceContextToLogContext(traceContext),
            event: "runtime.background_task.turn_cleanup_failed",
            module: "core.runtime",
            reason: stopped.reason,
            taskId: task.taskId,
          });
          return;
        }
        // stopBackgroundTask 返回的是取消已请求；底层进程退出事实由 ExecutionPort 等待。
        const settled = await runtime.executionPort?.waitForBackgroundTask?.(task.taskId);
        if (!settled?.result) {
          runtime.logger?.warn("Turn-bound Bash process settlement unavailable", {
            ...traceContextToLogContext(traceContext),
            event: "runtime.background_task.turn_cleanup_unconfirmed",
            module: "core.runtime",
            taskId: task.taskId,
          });
          return;
        }
        runtime.logger?.info("Turn-bound Bash process settled", {
          ...traceContextToLogContext(traceContext),
          event: "runtime.background_task.turn_cleanup_settled",
          module: "core.runtime",
          taskId: task.taskId,
        });
      } catch (error) {
        // 子进程清理失败不能把已成功写入的主任务改判失败；记录诊断，提交弹窗继续依 Git 事实决策。
        runtime.logger?.warn("Turn-bound Bash cleanup failed", {
          ...traceContextToLogContext(traceContext),
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "runtime.background_task.turn_cleanup_failed",
          module: "core.runtime",
          taskId: task.taskId,
        });
      }
    }),
  );
}
