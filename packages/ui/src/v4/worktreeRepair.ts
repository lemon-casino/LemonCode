import type { SessionLease } from "./sessionDataLayer.js";

/** 复用原 Host 的 projection；无新轮询队列，也不把 ACK 当作 AI 修复完成。 */
export async function waitForWorktreeRepair(lease: SessionLease): Promise<void> {
  let unsubscribe = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      const inspect = () => {
        const state = lease.store.getState();
        const phase = state.snapshot?.control.phase;
        if (phase === "completedSuccess") resolve();
        else if (phase === "error" || phase === "completedInterrupted")
          reject(new Error("worktreeRepairFailed"));
        else if (state.status === "error" || state.status === "closed")
          reject(new Error(state.lastError ?? "worktreeRepairDisconnected"));
      };
      unsubscribe = lease.store.subscribe(inspect);
      inspect();
    });
  } finally {
    unsubscribe();
    lease.release();
  }
}
