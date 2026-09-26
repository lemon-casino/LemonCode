import type { RuntimeCommand, RuntimeCommandId } from "../command-queue.js";
import { createTurnCancelledError } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";

type ResolvableRuntimeCommand<Result> = RuntimeCommand & {
  readonly id: RuntimeCommandId;
  readonly reject: (error: unknown) => void;
  readonly resolve: (result: Result) => void;
};

export function enqueueCancellableRuntimeCommand<
  Result,
  Command extends ResolvableRuntimeCommand<Result>,
>(
  runtime: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    createCommand: (handlers: {
      reject: (error: unknown) => void;
      resolve: (result: Result) => void;
    }) => Command;
    onCommandCancelled?: () => void;
  },
): Promise<Result> {
  if (runtime.shuttingDown) {
    // executeTurn、target continuation 等入口都会汇聚到这里；只在 admitPrompt 拒绝会留下旁路，
    // 让 stable close drain 返回后再次产生 session-store work。
    input.onCommandCancelled?.();
    return Promise.reject(createTurnCancelledError(new Error("Runtime is shutting down")));
  }
  return new Promise<Result>((resolve, reject) => {
    let settled = false;
    const abortSignal = input.abortSignal;
    const cleanup = () => {
      abortSignal?.removeEventListener("abort", abortQueuedCommand);
    };
    const resolveCommand = (result: Result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const rejectCommand = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const command = input.createCommand({
      reject: rejectCommand,
      resolve: resolveCommand,
    });
    function abortQueuedCommand() {
      if (settled) return;
      const removed = runtime.runtimeCommandQueue.removeById(command.id);
      if (removed) {
        input.onCommandCancelled?.();
        rejectCommand(createTurnCancelledError(abortSignal?.reason));
        return;
      }
      // 取消可能撞上 command 刚出队但尚未进入实际执行的窄窗口，先记账让执行侧跳过。
      runtime.runtimeCommandQueue.markCancelPending(command.id);
    }
    if (abortSignal?.aborted) {
      input.onCommandCancelled?.();
      rejectCommand(createTurnCancelledError(abortSignal.reason));
      return;
    }
    abortSignal?.addEventListener("abort", abortQueuedCommand, { once: true });
    runtime.enqueueRuntimeCommand(command);
  });
}
