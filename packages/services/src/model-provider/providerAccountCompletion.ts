import type { AuthChallenge, AuthDriver, AuthGrant, AuthImportEntry } from "@lcode/provider-node";
import type { ProviderAccountImportResult, ProviderAuthorization } from "@lcode/shared";
import { grantSchema, type StoredAccount } from "./providerAccountStoreSchema.js";
import { admitProviderAccount, safeAccountLabel } from "./providerAccountAdmission.js";
import { authorizationFailureMessage } from "./providerAccountStorage.js";

export interface AccountAuthorizationAttempt {
  view: ProviderAuthorization;
  controller: AbortController;
  driver: AuthDriver;
  challenge: AuthChallenge;
  completion?: Promise<void>;
}
interface CompletionHost {
  closed(): boolean;
  channel(id: string): { id: string; name: string };
  mutate(update: (accounts: StoredAccount[]) => void): Promise<void>;
  rollback(update: (accounts: StoredAccount[]) => void): Promise<void>;
  resetDriver(id: string): Promise<void>;
  useDriver(id: string, driver: AuthDriver): void;
  refreshEnabled(id: string): Promise<void>;
  publish(): Promise<unknown>;
}

/** The Host owns the attempt and all writes; this sequence has no cache or independent lifecycle. */
export async function completeProviderAccountAuthorization(
  host: CompletionHost,
  attempt: AccountAuthorizationAttempt,
  code?: string,
): Promise<void> {
  try {
    const batch = Boolean(attempt.challenge.completeMany);
    const entries: readonly AuthImportEntry[] = attempt.challenge.completeMany
      ? await attempt.challenge.completeMany()
      : [{ status: "ready", grant: await attempt.challenge.complete(code) }];
    if (entries.length > 200) throw new Error("Too many imported accounts");
    if (attempt.controller.signal.aborted || host.closed()) return;
    const channel = host.channel(attempt.view.channelId);
    const results: ProviderAccountImportResult[] = [];
    const createdGenerations = new Map<string, number>();
    await host.mutate((accounts) => {
      attempt.controller.signal.throwIfAborted();
      for (const [index, entry] of entries.entries()) {
        const label = safeAccountLabel(entry.label);
        const base = { index, ...(label ? { label } : {}) };
        if (entry.status !== "ready") {
          results.push({
            ...base,
            status: entry.status,
            ...(entry.status === "failed" ? { error: "invalid_credentials" as const } : {}),
          });
          continue;
        }
        const parsed = grantSchema.safeParse(entry.grant);
        if (!parsed.success) {
          results.push({ ...base, status: "failed", error: "invalid_credentials" });
          continue;
        }
        results.push({
          ...base,
          ...admitProviderAccount(accounts, channel, parsed.data as AuthGrant),
        });
      }
      for (const row of results)
        if (row.status === "added" && row.connectionId)
          createdGenerations.set(
            row.connectionId,
            accounts.find((a) => a.connectionId === row.connectionId)!.generation,
          );
    });
    const changed = results.filter((row) => row.connectionId && row.status !== "failed");
    // 轮换凭据一旦持久化即不能退回旧token；先废止旧driver，再处理取消期间的新连接撤销。
    for (const row of changed)
      if (row.status !== "exists") await host.resetDriver(row.connectionId!);
    if (attempt.controller.signal.aborted) {
      await host.rollback((accounts) => {
        // 保存期间另一Host可能已重新授权同一连接；取消只能撤销本attempt仍拥有的新增代次。
        for (let index = accounts.length - 1; index >= 0; index--)
          if (createdGenerations.get(accounts[index]!.connectionId) === accounts[index]!.generation)
            accounts.splice(index, 1);
      });
      await attempt.driver.dispose?.();
      return;
    }
    const connectionId = changed[0]?.connectionId;
    if (!batch && connectionId && changed[0]?.status !== "exists")
      host.useDriver(connectionId, attempt.driver);
    else await attempt.driver.dispose?.();
    attempt.view = {
      ...attempt.view,
      status: "completed",
      ...(connectionId ? { connectionId } : {}),
      ...(batch ? { results } : {}),
    };
    for (const row of changed)
      if (row.status !== "exists") await host.refreshEnabled(row.connectionId!);
    await host.publish();
  } catch (error) {
    if (!attempt.controller.signal.aborted)
      attempt.view = {
        ...attempt.view,
        status: "failed",
        error: authorizationFailureMessage(error),
      };
    await attempt.driver.dispose?.();
  }
}
