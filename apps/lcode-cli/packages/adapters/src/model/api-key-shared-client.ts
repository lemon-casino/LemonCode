import {
  RoutingError,
  readRateLimitHint,
  readRateLimitScope,
  type RoutingFinish,
  type SharedQuotaCoordinator,
} from "@lcode/provider";
import type { ApiKeyLease } from "./api-key-lease.js";

const MAX_IO_ATTEMPTS = 3,
  MAX_FAILED_LEASES = 256,
  MAX_LEASE_OPERATIONS = 64;
/** 原租约内有界串行反馈；共享余额与恢复许可唯一归 coordinator，不重试 dispatch/HTTP。 */
export class ApiKeySharedQuotaClient {
  private readonly pending = new Set<Promise<void>>();
  private readonly failed = new Map<
    string,
    {
      error: unknown;
      retry: () => Promise<void>;
      providerId: string;
      poolId: string;
      leaseId: string;
    }
  >();
  private overflow?: RoutingError;
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
    const identity = JSON.stringify([handle.poolKey, handle.leaseId]);
    let requested = false,
      dispatched = false,
      failure: unknown;
    const operations: Array<() => Promise<void>> = [];
    let tail = Promise.resolve();
    const pump = () => {
      tail = tail.then(async () => {
        while (operations.length) {
          let error: unknown;
          for (let attempt = 0; attempt < MAX_IO_ATTEMPTS; attempt++) {
            try {
              await operations[0]!();
              error = undefined;
              break;
            } catch (cause) {
              error = cause;
              if (!(cause instanceof RoutingError) || cause.code !== "quota-owner-unavailable")
                break;
            }
          }
          if (error) {
            failure = error;
            if (this.failed.has(identity) || this.failed.size < MAX_FAILED_LEASES)
              this.failed.set(identity, {
                error,
                retry: flush,
                providerId,
                poolId: input.poolId,
                leaseId: handle.leaseId,
              });
            else this.overflow = new RoutingError("quota-owner-capacity", { phase: "feedback" });
            return;
          }
          operations.shift();
        }
        failure = undefined;
        this.failed.delete(identity);
      });
      const task = tail;
      this.pending.add(task);
      void task.finally(() => this.pending.delete(task));
    };
    const flush = async () => {
      await tail;
      if (operations.length) {
        pump();
        await tail;
      }
      if (failure) throw failure;
    };
    const enqueue = (operation: () => Promise<void>) => {
      if (operations.length >= MAX_LEASE_OPERATIONS)
        throw new RoutingError("quota-owner-capacity", { phase: "feedback" });
      operations.push(operation);
      pump();
    };
    return {
      ...lease,
      admit: async () => {
        if (requested) return false;
        requested = true;
        await flush();
        try {
          dispatched = await this.coordinator.dispatch(handle);
        } catch (error) {
          // 文件提交可能已完成但回执丢失；不能再次 dispatch，更不能把未知派发当网络/TLS 重试。
          if (error instanceof RoutingError && error.code === "quota-owner-unavailable")
            throw new RoutingError("dispatch-uncertain", {
              cause: error,
              scope: "pool",
              phase: "dispatch",
              dispatch: "uncertain",
            });
          throw error;
        }
        return dispatched;
      },
      rollbackDispatch: () => this.coordinator.rollbackDispatch(handle),
      observe: (status, headers) => {
        lease.observe(status, headers);
        // 入队时冻结事实；不能等 IO 执行时再读取已切换 pool 的新投影。
        if (headers) {
          const windows = (lease.sharedQuotaWindows?.() ?? input.windows).map((window) => ({
            ...window,
          }));
          enqueue(() => this.coordinator.observe(providerId, input.poolId, windows));
          if (status >= 400) {
            const hint = readRateLimitHint(headers);
            const feedback = {
              outcome: "failed" as const,
              statusCode: status,
              retryAfterMs: Math.min(86400000, hint.delayMs),
              rateLimitScope: status === 429 ? hint.scope : readRateLimitScope(headers),
            };
            enqueue(() => this.coordinator.usage(handle, {}, undefined, feedback));
          }
        }
      },
      end: (success) => {
        lease.end?.(success);
        if (dispatched) enqueue(() => this.coordinator.finish(handle));
      },
      observeUsage: (usage: RoutingFinish) => {
        lease.observeUsage?.(usage);
        const actual = { ...usage.actualDemands },
          tokens = usage.tokens ? { ...usage.tokens } : undefined;
        const feedback = {
          outcome: usage.outcome,
          statusCode: usage.statusCode,
          retryAfterMs: usage.retryAfterMs,
          rateLimitScope: usage.rateLimitScope,
        };
        enqueue(() => this.coordinator.usage(handle, actual, tokens, feedback));
      },
      release: () => {
        lease.release();
        if (!dispatched) enqueue(() => this.coordinator.cancel(handle));
      },
      flushRouting: flush,
    };
  }
  diagnostics(providerId?: string) {
    const failed = [...this.failed.values()].filter(
      (item) => !providerId || item.providerId === providerId,
    );
    return {
      pendingScope: "execution" as const,
      pendingOperations: this.pending.size,
      failedLeases: failed.length,
      overflowed: Boolean(this.overflow),
      failures: failed.map((item) => ({
        providerId: item.providerId,
        poolId: item.poolId,
        leaseId: item.leaseId,
        code: item.error instanceof RoutingError ? item.error.code : "quota-owner-unavailable",
        phase: "feedback" as const,
      })),
    };
  }
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.all(this.pending);
    // retry 会修改失败目录，先冻结本轮范围，避免 close 把后来加入的错误也无限纳入。
    const failures = Array.from(this.failed.values());
    for (const item of failures) {
      try {
        await item.retry();
      } catch {
        /* 原失败仍由同租约持有，下面向真正的 close owner 报告。 */
      }
    }
    if (this.failed.size) throw this.failed.values().next().value!.error;
    if (this.overflow) throw this.overflow;
  }
}
