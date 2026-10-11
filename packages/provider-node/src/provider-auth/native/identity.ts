import type { AuthGrant } from "../driver.js";
import { jwt, record, text, type Json } from "./common.js";

export function accountIdentity(
  channel: string,
  user: string,
  organization = "",
): string | undefined {
  return user.trim()
    ? JSON.stringify([channel, user.trim().toLowerCase(), organization])
    : undefined;
}
export function safeDisplay(value: unknown): string {
  return text(value)
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .slice(0, 160)
    .trim();
}
export function openAIIdentity(grant: AuthGrant, idToken: string, channel = "codex"): AuthGrant {
  const claims = jwt(idToken);
  const auth = record(claims["https://api.openai.com/auth"]);
  const email = text(claims.email) || text(grant.email);
  const accountId = text(auth.chatgpt_account_id) || text(grant.accountId);
  const user = email || text(claims.sub);
  return {
    ...grant,
    ...(idToken ? { idToken } : {}),
    accountId: accountId || undefined,
    email: email || undefined,
    identityKey: accountIdentity(channel, user, accountId),
    displayName: safeDisplay(email || user) || undefined,
    plan: text(auth.chatgpt_plan_type) || grant.plan,
  };
}
export function claudeIdentity(grant: AuthGrant, profile: Json, status: Json = {}): AuthGrant {
  const account = record(profile.oauthAccount);
  const email =
    text(account.emailAddress) || text(status.email) || text(profile.email) || text(grant.email);
  const org =
    text(account.organizationUuid) || text(account.organizationName) || text(status.orgName);
  const id = text(account.accountUuid) || email;
  return {
    ...grant,
    email: email || undefined,
    accountId: id || grant.accountId,
    ...(id ? { identityKey: accountIdentity("claude", id, org) } : {}),
    ...(email
      ? {
          displayName:
            safeDisplay(email) +
            (org && text(account.organizationName)
              ? ` · ${safeDisplay(account.organizationName)}`
              : ""),
        }
      : {}),
    plan: grant.plan || text(status.subscriptionType),
  };
}
