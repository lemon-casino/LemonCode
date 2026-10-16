import type { AuthChallenge, AuthDriver, AuthGrant, AuthImportEntry } from "@lcode/provider-node";
import type { ProviderAccountImportResult, ProviderAuthorization } from "@lcode/shared";
import { grantSchema, type StoredAccount } from "./providerAccountStoreSchema.js";
import { admitProviderAccount, safeAccountLabel } from "./providerAccountAdmission.js";
import { authorizationFailureMessage } from "./providerAccountStorage.js";
import {
  updateAuthorizationProgress,
  failAuthorizationProgress,
} from "./providerAuthorizationProgress.js";

export interface AccountAuthorizationAttempt {
  view: ProviderAuthorization;
  controller: AbortController;
  driver: AuthDriver;
  challenge: AuthChallenge;
  completion?: Promise<void>;
  startedAt?: number;
}
/** 同一 attempts Map 中的无资源终态；开始阶段失败无需伪造 challenge/driver。 */
export type AccountAuthorizationRecord =
  | AccountAuthorizationAttempt
  | { view: ProviderAuthorization; startedAt?: number };
interface CompletionHost {
  closed(): boolean;
  channel(id: string): { id: string; name: string };
  mutate(update: (accounts: StoredAccount[]) => void): Promise<void>;
  rollback(update: (accounts: StoredAccount[]) => void): Promise<void>;
  adoptDriver(id: string, driver?: AuthDriver): Promise<void>;
  refreshEnabled(id: string): Promise<void>;
  publish(): Promise<unknown>;
  retireDriver?(driver: AuthDriver): Promise<void>;
}

/** The Host owns the attempt and all writes; this sequence has no cache or independent lifecycle. */
export async function completeProviderAccountAuthorization(
  host: CompletionHost,
  attempt: AccountAuthorizationAttempt,
  code?: string,
): Promise<void> {
  let committed = false,
    handedOff = false,
    saved = false;
  const retire = () =>
    host.retireDriver ? host.retireDriver(attempt.driver) : attempt.driver.dispose?.();
  try {
    if (!attempt.view.diagnostic?.code)
      updateAuthorizationProgress(attempt, { phase: "exchange", credentialsSaved: false });
    const batch = Boolean(attempt.challenge.completeMany);
    const entries: readonly AuthImportEntry[] = attempt.challenge.completeMany
      ? await attempt.challenge.completeMany()
      : [{ status: "ready", grant: await attempt.challenge.complete(code) }];
    if (entries.length > 200) throw new Error("Too many imported accounts");
    if (attempt.controller.signal.aborted || host.closed()) return;
    const channel = host.channel(attempt.view.channelId);
    const results: ProviderAccountImportResult[] = [];
    const createdGenerations = new Map<string, number>();
    updateAuthorizationProgress(attempt, { phase: "persisting", credentialsSaved: false });
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
    // 凭据提交是授权完成点；后续清理和目录失败不能回退成授权失败或关闭已移交 driver。
    if (attempt.controller.signal.aborted) {
      await host.rollback((accounts) => {
        // 保存期间另一Host可能已重新授权同一连接；取消只能撤销本attempt仍拥有的新增代次。
        for (let index = accounts.length - 1; index >= 0; index--)
          if (createdGenerations.get(accounts[index]!.connectionId) === accounts[index]!.generation)
            accounts.splice(index, 1);
      });
      await retire();
      return;
    }
    committed = true;
    saved = changed.length > 0;
    const post = async (run: () => unknown) => {
      try {
        await run();
      } catch (error) {
        failAuthorizationProgress(attempt, error, "post-login", saved);
      }
    };
    const connectionId = changed[0]?.connectionId;
    attempt.view = {
      ...attempt.view,
      status: "completed",
      ...(connectionId ? { connectionId } : {}),
      ...(batch ? { results } : {}),
    };
    updateAuthorizationProgress(attempt, {
      phase: "post-login",
      credentialsSaved: saved,
      followupPending: true,
    });
    const adopted = changed
      .filter((row) => row.status !== "exists")
      .map((row) => {
        const driver = !batch && row.connectionId === connectionId ? attempt.driver : undefined;
        if (driver) handedOff = true;
        // 原 owner 在返回 Promise 前同步替换缓存，旧 driver 的异步关闭不得留下无主窗口。
        return post(() => host.adoptDriver(row.connectionId!, driver));
      });
    await Promise.all(adopted);
    if (!handedOff) await post(retire);
    for (const row of changed)
      if (row.status !== "exists") await post(() => host.refreshEnabled(row.connectionId!));
    await post(() => host.publish());
    updateAuthorizationProgress(
      attempt,
      attempt.view.diagnostic?.code
        ? { ...attempt.view.diagnostic, followupPending: false }
        : { phase: "completed", credentialsSaved: saved, followupPending: false },
    );
  } catch (error) {
    if (committed) {
      attempt.view = { ...attempt.view, status: "completed" };
      failAuthorizationProgress(attempt, error, "post-login", saved);
      updateAuthorizationProgress(attempt, { ...attempt.view.diagnostic!, followupPending: false });
      if (!handedOff) await retire();
      return;
    }
    if (!attempt.controller.signal.aborted)
      attempt.view = {
        ...attempt.view,
        status: "failed",
        error: authorizationFailureMessage(error),
      };
    failAuthorizationProgress(attempt, error, attempt.view.diagnostic?.phase ?? "exchange");
    await retire();
  }
}
