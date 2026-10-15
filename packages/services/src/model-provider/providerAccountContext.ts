import type { AuthDriverContext, AuthGrant } from "@lcode/provider-node";
import { grantSchema, type StoredAccount } from "./providerAccountStoreSchema.js";

export function createProviderAccountContext(
  store: {
    read(): Promise<StoredAccount[]>;
    mutate(update: (accounts: StoredAccount[]) => void): Promise<void>;
  },
  account: StoredAccount,
  signal?: AbortSignal,
  ownerActive: () => boolean = () => true,
): AuthDriverContext & { isCurrent(current: StoredAccount): boolean } {
  let generation = account.generation;
  const writeGrant = async (
    grant: AuthGrant,
    rotating: boolean,
    expectedGeneration = generation,
  ) => {
    if (!rotating) signal?.throwIfAborted();
    await store.mutate((accounts) => {
      if (!rotating) signal?.throwIfAborted();
      const current = accounts.find((item) => item.connectionId === account.connectionId);
      // 轮换成功后的收尾可脱离 caller，但删除、禁用、重新授权和 Host 退休仍需 fencing。
      if (
        !ownerActive() ||
        !current ||
        !current.enabled ||
        current.generation !== expectedGeneration
      )
        throw new Error("Stale account credential update");
      current.grant = grantSchema.parse(grant);
      current.generation++;
      generation = current.generation;
    });
  };
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
    write: (grant) => writeGrant(grant, false),
    captureRefreshCommit: () => {
      const expectedGeneration = generation;
      return (grant) => writeGrant(grant, true, expectedGeneration);
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
