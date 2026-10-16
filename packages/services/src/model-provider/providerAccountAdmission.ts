import { randomUUID } from "node:crypto";
import type { AuthGrant } from "@lcode/provider-node";
import type { ProviderAccountImportResult } from "@lcode/shared";
import type { StoredAccount } from "./providerAccountStoreSchema.js";

export function safeAccountLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text &&
    text.length <= 160 &&
    ![...text].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    !/bearer\s|(?:access|refresh)[_-]?token|https?:\/\//iu.test(text)
    ? text
    : undefined;
}
const explicitIdentity = (grant: AuthGrant) =>
  typeof grant.identityKey === "string" && grant.identityKey ? grant.identityKey : undefined;
const sameCredential = (left: AuthGrant, right: AuthGrant) =>
  left.type === right.type &&
  Boolean(
    left.refresh
      ? left.refresh === right.refresh
      : left.type === "api" && left.key
        ? left.key === right.key
        : left.access && left.access === right.access,
  );

/** Called only inside the account storage mutation, so concurrent windows share the same dedupe. */
export function admitProviderAccount(
  accounts: StoredAccount[],
  channel: { id: string; name: string },
  grant: AuthGrant,
): Pick<ProviderAccountImportResult, "status" | "connectionId"> {
  const key = explicitIdentity(grant);
  const existing = accounts.find((account) => {
    if (account.channelId !== channel.id) return false;
    const stored = account.grant as AuthGrant;
    const storedKey = explicitIdentity(stored);
    // 旧accountId不是新的账号+组织复合key；只凭同一私有凭据升级，双方明确不同组织则不可合并。
    if (key && storedKey) return key === storedKey;
    if (!key && !storedKey && grant.accountId && stored.accountId)
      return grant.accountId === stored.accountId;
    if (grant.accountId && stored.accountId && grant.accountId !== stored.accountId) return false;
    return sameCredential(grant, stored);
  });
  if (existing) {
    const next = { ...grant };
    // 手工key重登可能不返回身份；同一凭据已确认的稳定身份不能因此丢失，造成下次轮换重复建号。
    for (const field of ["identityKey", "accountId"] as const)
      if (next[field] === undefined && typeof existing.grant[field] === "string")
        next[field] = existing.grant[field];
    if (JSON.stringify(existing.grant) === JSON.stringify(next))
      return { status: "exists", connectionId: existing.connectionId };
    // 同一身份的重新授权更新凭据，但保留connection、启停和用户别名，避免拆散统计归属。
    existing.grant = next;
    existing.generation++;
    existing.routingEpoch = (existing.routingEpoch ?? 0) + 1;
    delete existing.error;
    delete existing.authorizationStatus;
    return { status: "updated", connectionId: existing.connectionId };
  }
  const connectionId = randomUUID();
  accounts.push({
    connectionId,
    channelId: channel.id,
    displayName:
      safeAccountLabel(grant.displayName) ??
      safeAccountLabel(grant.email) ??
      `${channel.name} ${accounts.filter((a) => a.channelId === channel.id).length + 1}`,
    enabled: true,
    generation: 1,
    routingEpoch: 1,
    grant,
    models: [],
  });
  return { status: "added", connectionId };
}
