// ============================================================
// AgentRuntime-backed WorkflowDriver：actor runtime 关闭与重试
// ============================================================
// 关闭状态留在 driver 的同一 SessionState 上；sessions、创建计数及 dispose completion
// 不转移到这里。等待完整 turn handler → 同一路 closeBrowserSession → 成功后交还 driver 删除。

import type { AgentRuntimeWorkflowDriverDeps, SessionState } from "./workflow-driver-types.js";

const ACTOR_RUNTIME_CLOSE_RETRY_MS = 1_000;

/** driver 仍是唯一资源 owner：这里只能查询持有关系、请求它完成释放。 */
export interface ActorRuntimeCleanupHost {
  readonly deps: Pick<AgentRuntimeWorkflowDriverDeps, "clock" | "logger">;
  ownsSession(state: SessionState): boolean;
  completeActorRuntimeClose(state: SessionState): void;
}

/** actor release 重试属于持久关闭工作；生产 timer 不能 unref 后随进程提前消失。 */
export function createActorRuntimeCloseRetryTimer(
  callback: () => void,
  delayMs: number,
): ReturnType<typeof setTimeout> {
  return setTimeout(callback, delayMs);
}

function scheduleActorRuntimeCloseRetry(callback: () => void, delayMs: number): () => void {
  const timer = createActorRuntimeCloseRetryTimer(callback, delayMs);
  return () => clearTimeout(timer);
}

export function prepareActorRuntimeForDispose(state: SessionState): void {
  state.modelActivity.unsubscribe();
  state.cancelRedrive?.();
  state.cancelRedrive = undefined;
}

export function closeActorRuntimeAfterTurn(
  host: ActorRuntimeCleanupHost,
  state: SessionState,
): void {
  if (state.runtimeCloseReady) {
    closeActorRuntime(host, state);
    return;
  }
  if (state.runtimeCloseWaitingForTurn) return;
  state.runtimeCloseWaitingForTurn = true;
  const close = (): void => {
    state.runtimeCloseWaitingForTurn = false;
    state.runtimeCloseReady = true;
    closeActorRuntime(host, state);
  };
  if (state.turn === undefined) close();
  else void state.turn.then(close, close);
}

function closeActorRuntime(host: ActorRuntimeCleanupHost, state: SessionState): void {
  if (!host.ownsSession(state) || state.runtimeCloseInFlight) return;
  state.cancelRuntimeCloseRetry?.();
  state.cancelRuntimeCloseRetry = undefined;
  const closeBrowserSession = state.runtime.closeBrowserSession;
  if (typeof closeBrowserSession !== "function") {
    // 纯 replay/minimal stub 没有 runtime 资源；把它视为已关闭，不能为测试桩无限重试。
    host.completeActorRuntimeClose(state);
    return;
  }
  const closeAttempt = Promise.resolve().then(() => closeBrowserSession.call(state.runtime));
  state.runtimeCloseInFlight = closeAttempt;
  void closeAttempt.then(
    () => {
      if (state.runtimeCloseInFlight !== closeAttempt) return;
      state.runtimeCloseInFlight = undefined;
      host.completeActorRuntimeClose(state);
    },
    (error: unknown) => {
      if (state.runtimeCloseInFlight !== closeAttempt) return;
      state.runtimeCloseInFlight = undefined;
      host.deps.logger?.warn?.("Dynamic workflow actor runtime close failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "dynamic_workflow.actor_runtime.close_failed",
        module: "bootstrap.app",
        sessionId: state.sessionId,
      });
      const schedule = host.deps.clock?.schedule ?? scheduleActorRuntimeCloseRetry;
      state.cancelRuntimeCloseRetry = schedule(() => {
        state.cancelRuntimeCloseRetry = undefined;
        closeActorRuntime(host, state);
      }, ACTOR_RUNTIME_CLOSE_RETRY_MS);
    },
  );
}
