import { resolve } from "node:path";
import {
  ClientCredentialsProvider,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type AuthProvider,
  type OAuthClientProvider,
} from "@modelcontextprotocol/client";
import type { McpServerConfig } from "@lcode/contracts";
import { OFFICIAL_MCP_AUTH_META_KEY } from "@lcode/shared";
import {
  createSharedLCodeCredentialStore,
  type SharedLCodeCredentialStore,
} from "../auth/shared-credentials.js";
import { buildMcpStdioEnv, createMcpTransportFetch } from "./network.js";
import { createCredentialKeyPrefix, type McpOAuthRuntimeOptions } from "./oauth.js";
import { createMcpOAuthTokenProvider } from "./oauth-provider.js";
import { ProcessTreeStdioClientTransport } from "./stdio-transport.js";
import { buildProjectMcpStdioEnv } from "./project-environment.js";
import {
  createOAuthAuthorizationStatus,
  isOfficialAuthConfig,
  resolveAuthorizationCodeOAuthConfig,
} from "./adapter-protocol.js";
import type { McpTransport } from "./adapter-types.js";

import type { McpAdapterOwner } from "./adapter-owner.js";

type McpTransportContext = Pick<
  McpAdapterOwner,
  | "workingDirectory"
  | "env"
  | "network"
  | "resolveOfficialStdioAuthMeta"
  | "createOfficialAuthFetch"
  | "createOAuthClientProvider"
  | "resolveCredentialStore"
  | "logger"
  | "clientName"
  | "credentialStore"
  | "mcpOAuth"
  | "updateCurrentRecordStatus"
>;

export async function createTransport(
  this: McpTransportContext,
  config: McpServerConfig,
  serverName: string,
  generation: number,
  _oauthAuthorizationTimeoutMs?: number,
  workingDirectory?: string,
  signal?: AbortSignal,
): Promise<{ transport: McpTransport }> {
  if (config.type === "stdio") {
    return {
      transport: new ProcessTreeStdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        cwd: config.cwd
          ? resolve(workingDirectory ?? this.workingDirectory ?? process.cwd(), config.cwd)
          : (workingDirectory ?? this.workingDirectory),
        env: config.projectEnvironment
          ? buildProjectMcpStdioEnv(
              buildMcpStdioEnv({ env: this.env, network: this.network }),
              config.projectEnvironment.overlay,
              process.platform,
              undefined,
              config.env,
            )
          : { ...buildMcpStdioEnv({ env: this.env, network: this.network }), ...config.env },
        ...(config.projectEnvironment
          ? { projectEnvironment: config.projectEnvironment, spawnSignal: signal }
          : {}),
        stderr: "pipe",
        ...(isOfficialAuthConfig(config) && config.official
          ? {
              requestMetaProvider: async () => {
                const authMeta = await this.resolveOfficialStdioAuthMeta(
                  serverName,
                  config,
                  signal,
                );
                return authMeta ? { [OFFICIAL_MCP_AUTH_META_KEY]: authMeta } : undefined;
              },
            }
          : {}),
      }),
    };
  }

  const fetch = createMcpTransportFetch({
    env: this.env,
    network: this.network,
  });
  if (config.type === "http") {
    const officialAuthFetch = this.createOfficialAuthFetch(config, serverName, generation);
    return {
      transport: new StreamableHTTPClientTransport(new URL(config.url), {
        // 官方鉴权路径下 authProvider 必为 undefined：不落 OAuth 凭据、
        // 不起 localhost 回调 server、401/403 不转授权流程。
        authProvider: this.createOAuthClientProvider(serverName, config),
        fetch: officialAuthFetch ?? fetch,
        requestInit: config.headers ? { headers: config.headers } : undefined,
      }),
    };
  }

  return {
    transport: new SSEClientTransport(new URL(config.url), {
      authProvider: this.createOAuthClientProvider(serverName, config),
      fetch,
      requestInit: config.headers ? { headers: config.headers } : undefined,
    }),
  };
}

/**
 * 运行期 auth provider。
 *
 * 过去这里对任何没有 Authorization header 的 HTTP/SSE MCP
 * 都创建一个完整 OAuth session——而 session 在返回前就 `listen(0)` 起了一个 callback server，
 * 即使凭据完全有效、根本不需要授权。同时完整 `OAuthClientProvider` 会让 401 走 SDK 的
 * `auth()`，绕过我们的 refresh 单飞锁。
 *
 * 现在 authorization_code 一律使用纯 AuthProvider：被动连接零 listener、零 discovery、零 DCR，
 * 交互授权只在 Phase 2 事务里发生。
 */
export function createOAuthClientProvider(
  this: McpTransportContext,
  serverName: string,
  config: McpServerConfig,
): AuthProvider | OAuthClientProvider | undefined {
  if (config.type === "stdio") return undefined;
  // 官方鉴权与 OAuth 互斥：官方 MCP 的失败只能由 LCode 登录/套餐解决，
  // 交出任何 authProvider 都会让 401 误转成 MCP 授权流程。
  if (isOfficialAuthConfig(config)) return undefined;
  const authorizationCodeOAuthConfig = resolveAuthorizationCodeOAuthConfig(config);
  if (authorizationCodeOAuthConfig) {
    return createMcpOAuthTokenProvider({
      config: authorizationCodeOAuthConfig,
      credentialStore: this.resolveCredentialStore(),
      fetchFn: createMcpTransportFetch({ env: this.env, network: this.network }),
      keyPrefix: createCredentialKeyPrefix(serverName, config.url, authorizationCodeOAuthConfig),
      ...(this.logger ? { logger: this.logger } : {}),
      serverName,
      serverUrl: config.url,
    });
  }
  if (config.oauth?.type === "client_credentials") {
    return new ClientCredentialsProvider({
      clientId: config.oauth.clientId,
      clientName: config.oauth.clientName ?? `${this.clientName}-${serverName}`,
      clientSecret: config.oauth.clientSecret,
      scope: config.oauth.scope,
    });
  }
  return undefined;
}

export function resolveCredentialStore(this: McpTransportContext): SharedLCodeCredentialStore {
  this.credentialStore ??= this.mcpOAuth?.credentialStore ?? createSharedLCodeCredentialStore();
  return this.credentialStore;
}

export function createAuthorizationCodeOAuthOptions(
  this: McpTransportContext,
  config: McpServerConfig,
  serverName: string,
  generation: number,
  oauthAuthorizationTimeoutMs?: number,
): McpOAuthRuntimeOptions | undefined {
  if (config.type === "stdio") return this.mcpOAuth;
  return {
    ...this.mcpOAuth,
    authorizationTimeoutMs: oauthAuthorizationTimeoutMs ?? this.mcpOAuth?.authorizationTimeoutMs,
    onAuthorizationRequired: async (context) => {
      this.updateCurrentRecordStatus(serverName, generation, {
        authorization: createOAuthAuthorizationStatus(context),
        status: "connecting",
      });
      await this.mcpOAuth?.onAuthorizationRequired?.(context);
    },
  };
}
