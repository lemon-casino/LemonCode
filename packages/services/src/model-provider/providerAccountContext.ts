import type { AuthDriverContext, AuthGrant } from "@lcode/provider-node";
import { grantSchema, type StoredAccount } from "./providerAccountStoreSchema.js";

export function createProviderAccountContext(
  store: {
    read(): Promise<StoredAccount[]>;
    mutate(update: (accounts: StoredAccount[]) => void): Promise<void>;
  },
  account: StoredAccount,
  signal?: AbortSignal,
): AuthDriverContext & { isCurrent(current: StoredAccount): boolean } {
  let generation = account.generation;
  return {
    isCurrent: (current) => current.enabled && current.generation === generation,
    signal,
    connectionId: account.connectionId,
    read: async () => {
      signal?.throwIfAborted();
      const current = (await store.read()).find(
        (item) => item.connectionId === account.connectionId,
      );
      if (!current || !current.enabled) throw new Error("Account unavailable");
      generation = current.generation;
      return current.grant as AuthGrant;
    },
    write: async (grant) => {
      signal?.throwIfAborted();
      await store.mutate((accounts) => {
        signal?.throwIfAborted();
        const current = accounts.find((item) => item.connectionId === account.connectionId);
        // 删除、禁用或其他刷新已推进版本时，旧请求不得覆写最新授权。
        if (!current || !current.enabled || current.generation !== generation)
          throw new Error("Stale account credential update");
        current.grant = grantSchema.parse(grant);
        current.generation++;
        generation = current.generation;
      });
    },
    reportSignIn: async (status) => {
      signal?.throwIfAborted();
      await store.mutate((accounts) => {
        signal?.throwIfAborted();
        const current = accounts.find((item) => item.connectionId === account.connectionId);
        if (!current || !current.enabled || current.generation !== generation)
          throw new Error("Stale account sign-in report");
        current.authorizationStatus = status;
      });
    },
  };
}
