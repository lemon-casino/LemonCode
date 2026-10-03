import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { resolveRuntimeExecutionFailoverScope } from "./model-failover-policy.js";
import { canActivateExecutionFailoverAtSafeBoundary } from "./model-failover-router.js";

/** 模型请求的取消域；用户切换模型不取消 Turn、工具或 checkout writer owner。 */
export function createModelSwitchRequest(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
) {
  const controller = new AbortController();
  const scope = resolveRuntimeExecutionFailoverScope(runtime);
  let closed = false;
  const inspectTarget = () => {
    if (closed || controller.signal.aborted || state.turnAbortSignal.aborted) return;
    const target = runtime.executionFailoverPolicyPort.resolve(scope);
    if (!target || target.status === "active" || target.status === "blocked") return;
    // 取消旧请求前复用普通 Router 的惰性能力预检，不能先停 A 再发现 B 不可用。
    if (!canActivateExecutionFailoverAtSafeBoundary(runtime, state, "userRequested")) return;
    controller.abort(new Error("User requested an immediate model switch"));
  };
  const unsubscribe = runtime.executionFailoverPolicyPort.subscribe?.(inspectTarget);
  inspectTarget();
  return {
    signal: AbortSignal.any([state.turnAbortSignal, controller.signal]),
    get interrupted() {
      return controller.signal.aborted;
    },
    close() {
      closed = true;
      unsubscribe?.();
    },
  };
}
