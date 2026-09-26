import type { AgentRuntimeInternal } from "../internal.js";

/**
 * 登记所有仍可能访问父 session store 的关闭工作：普通子代理 finalizer/cleanup 与 workflow
 * actor dispose 都必须走这里。先登记生产者，稳定 drain 才不会在 cleanup 尚未创建时误判为空。
 */
export function retainSessionStoreDependentCloseWork(
  runtime: AgentRuntimeInternal,
  work: Promise<void>,
): void {
  const tracked = runtime.trackResidencyBlockingWork(work);
  runtime.pendingSessionStoreDependentCloseWork.add(tracked);
  void tracked.then(
    () => {
      runtime.pendingSessionStoreDependentCloseWork.delete(tracked);
    },
    () => undefined,
  );
}

/** 等待期间 producer 可能登记新的 cleanup，因此必须循环到集合稳定为空。 */
export async function settleSessionStoreDependentCloseWork(
  runtime: AgentRuntimeInternal,
): Promise<void> {
  const failures: unknown[] = [];
  while (runtime.pendingSessionStoreDependentCloseWork.size > 0) {
    const pending = [...runtime.pendingSessionStoreDependentCloseWork];
    const outcomes = await Promise.allSettled(pending);
    for (const [index, outcome] of outcomes.entries()) {
      runtime.pendingSessionStoreDependentCloseWork.delete(pending[index]!);
      if (outcome.status === "rejected") failures.push(outcome.reason);
    }
  }
  // 单个 retained work 失败不能让 drain 越过仍可能写 session store 的 sibling。
  // 先稳定清空 owner，再按原错误语义向上传播；多错则保留全部原因。
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Session-store-dependent close work failed");
  }
}
