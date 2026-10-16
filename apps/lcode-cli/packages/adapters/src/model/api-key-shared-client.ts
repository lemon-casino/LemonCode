import { RoutingError, type RoutingFinish, type SharedQuotaCoordinator } from "@lcode/provider";
import type { ApiKeyLease } from "./api-key-lease.js";

/** 只串行同租约的 IO 反馈；唯一余额和派发状态仍在 coordinator。 */
export class ApiKeySharedQuotaClient {
  private readonly pending = new Set<Promise<void>>();
  private readonly errors: unknown[] = [];
  constructor(readonly coordinator: SharedQuotaCoordinator) {}
  async prepare(
    providerId: string,
    lease: ApiKeyLease,
    signal?: AbortSignal,
  ): Promise<ApiKeyLease> {
    const input = lease.sharedQuotaInput;
    if (!input) return lease;
    const handle = await this.coordinator.reserve({ ...input, providerId });
    if (signal?.aborted) {
      await this.coordinator.cancel(handle);
      signal.throwIfAborted();
    }
    let requested = false,
      dispatched = false,
      failure: unknown;
    let tail = Promise.resolve();
    const enqueue = (operation: () => Promise<void>) => {
      tail = tail.then(operation).catch((error) => {
        failure ??= error;
        this.errors.push(error);
      });
      const task = tail;
      this.pending.add(task);
      void task.finally(() => this.pending.delete(task));
    };
    const flush = async () => {
      await tail;
      if (failure) throw failure;
    };
    return {
      ...lease,
      admit: async () => {
        if (requested) return false;
        requested = true;
        await flush();
        dispatched = await this.coordinator.dispatch(handle);
        return dispatched;
      },
      rollbackDispatch: () => this.coordinator.rollbackDispatch(handle),
      observe: (status, headers) => {
        lease.observe(status, headers);
        if (headers)
          enqueue(() =>
            this.coordinator.observe(providerId, input.poolId, [
              ...(lease.sharedQuotaWindows?.() ?? input.windows),
            ]),
          );
      },
      end: (success) => {
        lease.end?.(success);
        if (dispatched) enqueue(() => this.coordinator.finish(handle));
      },
      observeUsage: (usage: RoutingFinish) => {
        lease.observeUsage?.(usage);
        enqueue(() => this.coordinator.usage(handle, usage.actualDemands ?? {}, usage.tokens));
      },
      release: () => {
        lease.release();
        if (!dispatched) enqueue(() => this.coordinator.cancel(handle));
      },
      flushRouting: flush,
    };
  }
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.all(this.pending);
    if (this.errors.length) throw this.errors[0] ?? new RoutingError("quota-owner-unavailable");
  }
}
