import { z } from "zod";
import type { AuthDriver, AuthDriverContext } from "@lcode/provider-node";
import type { ProviderAccountView } from "@lcode/shared";
import { modelSchema, type StoredAccount } from "./providerAccountStoreSchema.js";

interface CatalogHost {
  read(): Promise<StoredAccount[]>;
  driver(account: StoredAccount): Promise<AuthDriver>;
  context(
    account: StoredAccount,
    signal: AbortSignal,
  ): AuthDriverContext & { isCurrent(current: StoredAccount): boolean };
  track(id: string): AbortController;
  untrack(id: string, controller: AbortController): void;
  withAccountLock<T>(account: StoredAccount, operation: () => Promise<T>): Promise<T>;
  mutate(update: (accounts: StoredAccount[]) => void): Promise<void>;
  publish(): Promise<ProviderAccountView>;
}

/** 目录刷新只经原账号 owner 提交；提取编排以免展示/签到职责继续挤入账号服务。 */
export async function refreshProviderAccountCatalog(host: CatalogHost, connectionId: string) {
  const account = (await host.read()).find((item) => item.connectionId === connectionId);
  if (!account) throw new Error("Unknown account");
  const controller = host.track(connectionId),
    context = host.context(account, controller.signal);
  try {
    const catalog = await host.withAccountLock(account, async () => {
      controller.signal.throwIfAborted();
      const driver = await host.driver(account);
      return driver.modelCatalog
        ? driver.modelCatalog(context)
        : { models: await driver.models(context), fallback: false };
    });
    const models = z.array(modelSchema).parse(catalog.models);
    await host.mutate((accounts) => {
      controller.signal.throwIfAborted();
      const current = accounts.find((item) => item.connectionId === connectionId);
      // 其他 Host 重新授权时本地 controller 未必取消；检查实际读取/刷新的凭据代次。
      if (!current || !context.isCurrent(current)) throw new Error("Stale model catalog");
      // 静态 fallback 不是新事实，不能使成功目录及其计费元数据静默缩水。
      if (!catalog.fallback || !current.models.length) current.models = models;
      if (catalog.fallback)
        current.error = "Model catalog unavailable; showing the last available models.";
      else delete current.error;
    });
  } catch {
    if (!controller.signal.aborted)
      await host.mutate((accounts) => {
        const current = accounts.find((item) => item.connectionId === connectionId);
        if (current && context.isCurrent(current))
          current.error = "Unable to load models. Refresh or sign in again.";
      });
  } finally {
    host.untrack(connectionId, controller);
  }
  return host.publish();
}
