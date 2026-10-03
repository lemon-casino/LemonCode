import { isTerminalRuntimeTask } from "../../runtime-task/registry.js";
import type { AgentRuntimeInternal } from "../internal.js";

type CheckoutRuntime = Pick<
  AgentRuntimeInternal,
  "checkoutExecutionPort" | "runtimeTaskRegistry" | "sessionId" | "logger"
>;
interface LeaseState {
  lease: { release(): Promise<void> };
  active: number;
  drain?: Promise<void>;
  releasing?: Promise<void>;
}
const leases = new WeakMap<CheckoutRuntime, LeaseState>();
const acquisitions = new WeakMap<CheckoutRuntime, Promise<LeaseState>>();

export function acquireCheckoutWriterLease(
  this: AgentRuntimeInternal,
  executionId: string,
  signal: AbortSignal,
): Promise<{ release(): Promise<void> } | undefined> {
  return acquireCheckoutExecutionLease(this, executionId, signal);
}

function pendingWriters(runtime: CheckoutRuntime): string[] {
  return Object.values(runtime.runtimeTaskRegistry.all())
    .filter((task) => task.type !== "monitor_mcp" && !isTerminalRuntimeTask(task))
    .map((task) => task.taskId);
}

async function releaseWhenSettled(runtime: CheckoutRuntime, state: LeaseState): Promise<void> {
  if (state.active > 0 || leases.get(runtime) !== state) return;
  const pending = pendingWriters(runtime);
  if (pending.length) {
    if (!state.drain) {
      // 保留预览或后台子代理仍能写文件；前台完成不能让集成发布抢走同一 checkout。
      state.drain = Promise.all(
        pending.map((id) => runtime.runtimeTaskRegistry.waitForTerminal(id)),
      )
        .then(async () => {
          state.drain = undefined;
          await releaseWhenSettled(runtime, state);
        })
        .catch((error: unknown) => {
          state.drain = undefined;
          runtime.logger?.warn("Checkout writer settlement failed; retaining execution permit", {
            error: error instanceof Error ? error.message : String(error),
            sessionId: runtime.sessionId,
          });
        });
    }
    return;
  }
  state.releasing ??= state.lease.release().then(() => {
    if (leases.get(runtime) === state) leases.delete(runtime);
  });
  await state.releasing;
}

export async function acquireCheckoutExecutionLease(
  runtime: CheckoutRuntime,
  turnId: string,
  signal: AbortSignal,
): Promise<{ release(): Promise<void> } | undefined> {
  if (!runtime.checkoutExecutionPort) return undefined;
  signal.throwIfAborted();
  let state = leases.get(runtime);
  if (state?.releasing) {
    await state.releasing;
    signal.throwIfAborted();
    state = leases.get(runtime);
  }
  if (!state) {
    let pending = acquisitions.get(runtime);
    if (!pending) {
      pending = runtime.checkoutExecutionPort
        .acquire({ sessionId: runtime.sessionId, turnId, signal })
        .then((lease) => {
          const acquired = { lease, active: 0 };
          leases.set(runtime, acquired);
          return acquired;
        })
        .finally(() => {
          acquisitions.delete(runtime);
        });
      acquisitions.set(runtime, pending);
    }
    state = await pending;
  }
  state.active += 1;
  if (signal.aborted) {
    // 同一 runtime 的工作流可复用在途申请；等待者取消不能借另一个请求的票据开始写入。
    state.active -= 1;
    await releaseWhenSettled(runtime, state);
    signal.throwIfAborted();
  }
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      state.active -= 1;
      await releaseWhenSettled(runtime, state);
    },
  };
}
