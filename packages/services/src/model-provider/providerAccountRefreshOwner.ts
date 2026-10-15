import { withFileLock } from "@lcode/shared/node";
import { redactTelemetryText } from "@lcode/shared";
import { createServiceLogger } from "../logger/serviceLogger.js";

const log = createServiceLogger("provider-account-refresh");

/** 原账号锁的物理刷新收尾；不持有业务输入，也不调度新尝试。 */
export class ProviderAccountRefreshOwner {
  private readonly completions = new Map<string, Set<Promise<unknown>>>();
  constructor(private readonly lockPath: string) {}

  retain(connectionId: string, completion: Promise<unknown>): void {
    const retained = this.completions.get(connectionId);
    if (!retained) throw new Error("Credential refresh requires the original account lock");
    retained.add(completion);
    void completion.catch(() => {});
  }

  run<T>(connectionId: string, operation: () => Promise<T>): Promise<T> {
    return withFileLock(
      `${this.lockPath}.${connectionId}.request`,
      async () => {
        const retained = new Set<Promise<unknown>>();
        this.completions.set(connectionId, retained);
        try {
          return await operation();
        } finally {
          // caller 取消可提前结束业务，但落盘前不能让另一 Host 消费同一旧 token。
          const results = await Promise.allSettled(retained);
          for (const result of results)
            if (result.status === "rejected") {
              const error: unknown = result.reason;
              // caller 已离开时仍保留收尾失败的事实；不输出 grant 或供应商原响应。
              log.warn(undefined, "Credential rotation completion failed", {
                connectionId,
                errorType: error instanceof Error ? error.name : typeof error,
                message: redactTelemetryText(
                  error instanceof Error ? error.message : String(error),
                ),
              });
            }
          this.completions.delete(connectionId);
        }
      },
      { lockMaxWaitMs: 180_000 },
    );
  }
}
