import type { AuthDriver } from "./driver.js";
import type { HostApiNetworkTransport } from "../network-transport.js";

/** 原工厂拥有 driver 与注入的网络；不能因一个关闭失败跳过另一个资源。 */
export async function createOwnedAuthDriver(
  build: () => Promise<AuthDriver>,
  network?: HostApiNetworkTransport,
): Promise<AuthDriver> {
  let driver: AuthDriver;
  try {
    driver = await build();
  } catch (error) {
    try {
      await network?.disposeAndWait();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Provider initialization and cleanup failed", {
        cause: error,
      });
    }
    throw error;
  }
  let closed = false,
    closing: Promise<void> | undefined;
  const resources = [
    { done: false, close: () => driver.dispose?.() },
    { done: false, close: () => network?.disposeAndWait() },
  ];
  const admit = async <T>(run: () => Promise<T>): Promise<T> => {
    if (closed) throw new DOMException("Provider driver disposed", "AbortError");
    return run();
  };
  return {
    methods: () => admit(() => driver.methods()),
    authorize: (...args) => admit(() => driver.authorize(...args)),
    models: (...args) => admit(() => driver.models(...args)),
    fetch: (...args) => admit(() => driver.fetch(...args)),
    ...(driver.checkin
      ? {
          checkin: (...args: Parameters<NonNullable<AuthDriver["checkin"]>>) =>
            admit(() => driver.checkin!(...args)),
        }
      : {}),
    ...(driver.modelCatalog
      ? {
          modelCatalog: (...args: Parameters<NonNullable<AuthDriver["modelCatalog"]>>) =>
            admit(() => driver.modelCatalog!(...args)),
        }
      : {}),
    ...(driver.quota
      ? {
          quota: (...args: Parameters<NonNullable<AuthDriver["quota"]>>) =>
            admit(() => driver.quota!(...args)),
        }
      : {}),
    dispose() {
      if (closing) return closing;
      closed = true;
      // map 的 async callback 同步进入 close，保证封闭后立即取消；allSettled 保留全部故障。
      const operations = resources
        .filter((resource) => !resource.done)
        .map(async (resource) => {
          await resource.close();
          resource.done = true;
        });
      closing = Promise.allSettled(operations).then((results) => {
        const failures = results
          .filter((item) => item.status === "rejected")
          .map((item) => item.reason);
        if (failures.length)
          throw new AggregateError(failures, "Provider driver resource cleanup failed");
      });
      void closing.catch(() => {
        closing = undefined;
      });
      return closing;
    },
  };
}
