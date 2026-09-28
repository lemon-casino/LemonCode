import { createHash } from "node:crypto";
import type { McpOAuthConfig } from "@lcode/contracts";
import { type SharedLCodeCredentialStore } from "../auth/shared-credentials.js";
import { type McpOAuthAuthorizationContext } from "./oauth-shared.js";
type McpAuthorizationCodeOAuthConfig = Extract<McpOAuthConfig, { type: "authorization_code" }>;

export type { McpOAuthAuthorizationContext };

export interface McpOAuthRuntimeOptions {
  authorizationTimeoutMs?: number;
  credentialStore?: SharedLCodeCredentialStore;
  onAuthorizationRequired?: (context: McpOAuthAuthorizationContext) => Promise<void> | void;
  openAuthorizationUrl?: (context: McpOAuthAuthorizationContext) => Promise<void> | void;
}

export function createCredentialKeyPrefix(
  serverName: string,
  serverUrl: string,
  config: McpAuthorizationCodeOAuthConfig,
): string {
  // OAuth token 和动态 client 注册都依赖授权语义，scope/client/redirect 变化时必须重新授权。
  const hash = createHash("sha256")
    .update(
      [
        serverName,
        serverUrl,
        config.clientId ?? "",
        config.scope ?? "",
        config.redirectPath ?? "",
      ].join("\n"),
    )
    .digest("hex")
    .slice(0, 24);
  return `mcp:oauth:${hash}`;
}
