import { traceContextToLogContext } from "../deps.js";
import { throwIfTurnAborted } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeTaskSnapshot } from "../../runtime-task/registry.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { appendTurnRequestEntries } from "./turn-output-token-continuation.js";

export async function continueAfterBackgroundBash(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): Promise<boolean> {
  throwIfTurnAborted(state.turnAbortSignal);
  while (true) {
    const owned = Object.values(runtime.runtimeTaskRegistry.all()).filter((task) =>
      isOwnedFiniteBash(runtime, state, task),
    );
    if (owned.length === 0) return false;
    const hasQueuedResult = runtime.runtimeCommandQueue
      .snapshot()
      .some(
        (command) =>
          command.mode === "task-notification" &&
          owned.some(
            (task) =>
              task.taskId === command.taskId && task.lifecycleId === command.taskLifecycleId,
          ),
      );
    if (hasQueuedResult) {
      // 沿原 active-loop 通路落盘与消费，保留 FIFO barrier 和单次 claim。
      const drained = await runtime.drainPendingRuntimeCommandsForActiveLoop();
      state.backgroundSubagentResultConsumed ||= drained.backgroundSubagentResultConsumed;
      state.workflowResultConsumed ||= drained.workflowResultConsumed;
      appendTurnRequestEntries(state.turnRequestState, drained.runtimeEntries);
      if (drained.drained > 0) return true;
    }
    const running = owned.filter((task) => task.status === "running");
    if (running.length === 0) return false;
    // 模型 stop 仅是本次响应结束，不能取消还在执行的构建再抑制其结果。
    // 复用 registry 终态 waiter；任何一个结果到达即续跑，不轮询、不另设超时。
    runtime.logger?.info("Waiting for finite background Bash before turn completion", {
      ...traceContextToLogContext(state.turnTraceContext),
      event: "runtime.background_bash.completion_wait",
      module: "core.runtime",
      taskCount: running.length,
    });
    const waitController = new AbortController();
    const signal = AbortSignal.any([state.turnAbortSignal, waitController.signal]);
    try {
      await Promise.race(
        running.map((task) => runtime.runtimeTaskRegistry.waitForTerminal(task.taskId, { signal })),
      );
    } finally {
      // Promise.race 不撤销其它 waiter；必须解除它们，避免多任务续跑累积等待者。
      waitController.abort();
    }
    throwIfTurnAborted(state.turnAbortSignal);
  }
}

function isOwnedFiniteBash(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  task: RuntimeTaskSnapshot,
): boolean {
  return (
    task.type === "local_bash" &&
    task.isBackgrounded === true &&
    task.backgroundKind === "task" &&
    task.keepAliveAfterTask !== true &&
    task.turnId === state.turnId &&
    task.branchGeneration === runtime.branchGeneration
  );
}
