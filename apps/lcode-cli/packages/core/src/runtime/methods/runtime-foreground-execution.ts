import { traceContextToLogContext } from "../deps.js";
import type { RuntimeCommand } from "../command-queue.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { retainSessionStoreDependentCloseWork } from "./session-store-dependent-close-work.js";
import type {
  ActiveForegroundExecutionState,
  StopActiveForegroundExecutionOptions,
  StopActiveForegroundExecutionResult,
} from "../types.js";

export function beginForegroundExecution(
  this: AgentRuntimeInternal,
  command: RuntimeCommand,
): ActiveForegroundExecutionState {
  const controller = new AbortController();
  const parentAbortSignal = runtimeCommandAbortSignal(command);
  const abortFromParent = (): void => {
    controller.abort(parentAbortSignal?.reason);
  };
  if (parentAbortSignal?.aborted) {
    abortFromParent();
  } else {
    parentAbortSignal?.addEventListener("abort", abortFromParent, { once: true });
  }
  const state: ActiveForegroundExecutionState = {
    controller,
    disposeParentAbort: () => {
      parentAbortSignal?.removeEventListener("abort", abortFromParent);
    },
    foregroundExecutionId: String(command.id),
    preserveQueueAutoDrainOnCancel: false,
  };
  // 旧 Stop 只持有 bootstrap 外层 controller，而 goal verifier/continuation
  // 已经越过普通 turn 生命周期。取消域必须覆盖整条 runtime command，才能在两个阶段
  // 的交界处仍命中同一次前台执行。
  this.activeForegroundExecution = state;
  return state;
}

const FOREGROUND_EXECUTION_CLEANUP_RETRY_DELAY_MS = 1_000;

export async function finishForegroundExecution(
  this: AgentRuntimeInternal,
  state: ActiveForegroundExecutionState,
  traceContext: RuntimeCommand["traceContext"],
  waitForRetry: (delayMs: number) => Promise<void> = waitForForegroundExecutionCleanupRetry,
): Promise<void> {
  state.disposeParentAbort();
  if (this.activeForegroundExecution !== state) return;

  // execution 已经终态，先从实时目标中移除；但原 ID 由当前 command drain 持有，
  // policy 事件写失败时必须在同一 owner 内重试，不能抛出后让队列失去唤醒者。
  this.activeForegroundExecution = undefined;
  const cleanup = completeForegroundExecutionFailoverTarget.call(
    this,
    state,
    traceContext,
    waitForRetry,
  );
  retainSessionStoreDependentCloseWork(this, cleanup);
  await cleanup;
}

async function completeForegroundExecutionFailoverTarget(
  this: AgentRuntimeInternal,
  state: ActiveForegroundExecutionState,
  traceContext: RuntimeCommand["traceContext"],
  waitForRetry: (delayMs: number) => Promise<void>,
): Promise<void> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      await this.executionFailoverPolicyPort.complete(
        { foregroundExecutionId: state.foregroundExecutionId },
        traceContext,
      );
      return;
    } catch (error) {
      this.logger?.warn("Execution failover foreground target cleanup failed; retry scheduled", {
        ...traceContextToLogContext(traceContext),
        attempt,
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "model.failover.foreground_target_cleanup_retry_scheduled",
        foregroundExecutionId: state.foregroundExecutionId,
        module: "core.runtime",
      });
      await waitForRetry(FOREGROUND_EXECUTION_CLEANUP_RETRY_DELAY_MS);
    }
  }
}

function waitForForegroundExecutionCleanupRetry(delayMs: number): Promise<void> {
  // durable policy cleanup 未成功前保持进程存活；不能使用普通请求 backoff 的 unref timer。
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function runtimeCommandAbortSignal(command: RuntimeCommand): AbortSignal | undefined {
  if (
    command.mode === "prompt" ||
    command.mode === "target-continuation" ||
    command.mode === "target-continuation-loop"
  ) {
    return command.options?.abortSignal;
  }
  return undefined;
}

export function stopActiveForegroundExecution(
  this: AgentRuntimeInternal,
  options: StopActiveForegroundExecutionOptions = {},
): StopActiveForegroundExecutionResult {
  const active = this.activeForegroundExecution;
  if (!active || active.controller.signal.aborted) {
    return { kind: "idle" };
  }
  if (
    options.expectedForegroundExecutionId !== undefined &&
    options.expectedForegroundExecutionId !== active.foregroundExecutionId
  ) {
    return {
      kind: "mismatch",
      activeForegroundExecutionId: active.foregroundExecutionId,
    };
  }
  // sendQueuedNow 的内部抢占过去与用户手动 Stop 共用同一种 cancelled，
  // turn catch 因而把 queueAutoDrain 关闭。把调用意图固定在当前 foreground
  // execution 上，保证超时后迟到的 TurnComplete 仍能保留原队列授权。
  active.preserveQueueAutoDrainOnCancel = options.preserveQueueAutoDrainOnCancel === true;
  active.controller.abort(new Error(options.reason ?? "foreground execution stopped"));
  return {
    kind: "stopped",
    foregroundExecutionId: active.foregroundExecutionId,
  };
}

export function getActiveForegroundExecutionId(this: AgentRuntimeInternal): string | undefined {
  return this.activeForegroundExecution?.foregroundExecutionId;
}

/** promotion lease 已阻止其他 FIFO 项起跑；此处只读旧前台及其真实收尾，不把 lease 当成 busy。 */
export function isForegroundExecutionIdleForPromotion(this: AgentRuntimeInternal): boolean {
  // execution id 在 durable policy 清理前已移出实时目标；仅看 id 会提前宣告 idle，
  // 随后的 requireIdle admission 又被仍在 finally 的 drain 拒绝。
  return (
    this.activeForegroundExecution === undefined &&
    !this.runtimeCommandDrainActive &&
    this.activeTurn === undefined &&
    this.activeTurnStartReservation === undefined
  );
}
