import type { IWorktreeService, CheckoutLease } from "../worktree/contract.js";

/** 协议 client 是许可代际；断连不能释放，只有进程树回收确认后才结算。 */
export function createWorktreeClientLeases(service: IWorktreeService, clientId: string) {
  const leases = new Map<string, CheckoutLease>();
  const pending = new Set<Promise<unknown>>();
  let exited = false;
  const owner = (id: string) => `${clientId}:${id}`;
  const scoped = Object.create(service) as IWorktreeService;
  scoped.acquireCheckout = async (params) => {
    if (exited) throw new Error("Agent process already exited");
    const operation = service
      .acquireCheckout({ ...params, ownerId: owner(params.ownerId) })
      .then(async (lease) => {
        leases.set(lease.token, lease);
        if (exited) {
          // 退出与申请响应交错时，不能遗失已经授予的 OS 锁或让旧 client 继续执行。
          await service.releaseCheckout(lease);
          leases.delete(lease.token);
          throw new Error("Agent process exited before checkout grant");
        }
        return lease;
      });
    pending.add(operation);
    try {
      return await operation;
    } finally {
      pending.delete(operation);
    }
  };
  scoped.releaseCheckout = async (params) => {
    await service.releaseCheckout({ ...params, ownerId: owner(params.ownerId) });
    leases.delete(params.token);
  };
  return {
    service: scoped,
    async disposeAfterProcessExit() {
      exited = true;
      await Promise.allSettled(pending);
      // 释放失败的 token 保留在本 owner 中，重复的进程回收仍可重试。
      for (const [token, lease] of leases) {
        await service.releaseCheckout(lease);
        leases.delete(token);
      }
    },
  };
}
