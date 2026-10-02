import { isDeepStrictEqual } from "node:util";
import { computeScopeUnion } from "@modelcontextprotocol/client";
import type { McpServerConfig, McpServerStatus } from "@lcode/contracts";
import { createSharedLCodeCredentialStore } from "../auth/shared-credentials.js";
import { createMcpTransportFetch } from "./network.js";
import { createCredentialKeyPrefix } from "./oauth.js";
import { loadCredentialPair } from "./oauth-credentials.js";
import type { InteractiveAuthorizationTrigger } from "./oauth-errors.js";
import {
  MCP_OAUTH_AUTHORIZATION_TRANSACTION_TTL_MS,
  runMcpInteractiveAuthorization,
  type McpInteractiveAuthorizationOutcome,
} from "./oauth-interactive.js";
import {
  DEFAULT_MCP_TIMEOUT_MS,
  type AuthorizationCodeOAuthConfig,
  type McpClient,
  type McpServerRecord,
  type McpTransport,
} from "./adapter-types.js";

import type { McpAdapterOwner } from "./adapter-owner.js";

type McpOAuthRecoveryContext = Pick<
  McpAdapterOwner,
  | "records"
  | "nextConnectionGeneration"
  | "createStatus"
  | "runToolCallAuthorizationRecovery"
  | "closeClientAndTransport"
  | "runInteractiveOAuthAuthorization"
  | "openServerConnection"
  | "failConnection"
  | "createAuthorizationCodeOAuthOptions"
  | "adapterInstanceId"
  | "env"
  | "network"
  | "logger"
>;

/**
 * 创建或复用运行期 OAuth 恢复。完整的 Phase 2 → Phase 1 由 adapter-owned record 持有；
 * tool caller 只能等待，不能用自己的 AbortSignal 终止共享事务。
 */
export function ensureToolCallAuthorizationRecovery(
  this: McpOAuthRecoveryContext,
  input: {
    config: Extract<McpServerConfig, { type: "http" | "sse" }>;
    name: string;
    oauthConfig: AuthorizationCodeOAuthConfig;
    record: McpServerRecord;
    trigger: InteractiveAuthorizationTrigger;
  },
): Promise<McpServerStatus> {
  const current = this.records.get(input.name);
  if (
    current?.connecting &&
    current.status.status === "connecting" &&
    isDeepStrictEqual(current.config, input.config)
  ) {
    return current.connecting;
  }

  const generation = this.nextConnectionGeneration(input.name);
  const abortController = new AbortController();
  const recoveryRecord: McpServerRecord = {
    abortController,
    config: input.config,
    status: this.createStatus(input.config, "connecting", {
      toolCount: input.record.tools.length,
    }),
    // 运行期工具已经向 core 广告；恢复期间保留 descriptor，避免设置页/借用端口误判工具消失。
    tools: input.record.tools,
  };
  this.records.set(input.name, recoveryRecord);
  const connecting = this.runToolCallAuthorizationRecovery({
    abortController,
    config: input.config,
    generation,
    name: input.name,
    oauthConfig: input.oauthConfig,
    previousClient: input.record.client,
    previousTransport: input.record.transport,
    trigger: input.trigger,
  });
  recoveryRecord.connecting = connecting;
  return connecting;
}

export async function runToolCallAuthorizationRecovery(
  this: McpOAuthRecoveryContext,
  input: {
    abortController: AbortController;
    config: Extract<McpServerConfig, { type: "http" | "sse" }>;
    generation: number;
    name: string;
    oauthConfig: AuthorizationCodeOAuthConfig;
    previousClient?: McpClient;
    previousTransport?: McpTransport;
    trigger: InteractiveAuthorizationTrigger;
  },
): Promise<McpServerStatus> {
  const startedAt = Date.now();
  try {
    // 原 transport 的握手与 token 已失效，必须由共享 owner 统一退休；不能调用 connectServer，
    // 否则 closeRecord 会 abort recoveryRecord 自己的 controller，形成自取消。
    await this.closeClientAndTransport(input.name, input.previousClient, input.previousTransport);
    const outcome = await this.runInteractiveOAuthAuthorization({
      config: input.config,
      generation: input.generation,
      name: input.name,
      oauthConfig: input.oauthConfig,
      serverUrl: input.config.url,
      signal: input.abortController.signal,
      trigger: input.trigger,
    });
    if (outcome.status === "authorized" || outcome.status === "already-authorized") {
      return await this.openServerConnection({
        config: input.config,
        generation: input.generation,
        name: input.name,
        oauthAuthorizationAttempted: true,
        signal: input.abortController.signal,
        timeoutMs: input.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
      });
    }
    return await this.failConnection({
      config: input.config,
      error:
        outcome.status === "pending"
          ? new Error(
              `MCP server ${input.name} OAuth authorization is still in progress; complete it in the browser and reconnect`,
            )
          : outcome.error,
      failureKind: "oauth_authorization_failed",
      generation: input.generation,
      name: input.name,
      startedAt,
    });
  } catch (error) {
    // 防御边界：共享 recovery promise 必须是 total operation。任何未来新增的编排异常也只能
    // 收敛为 failed record，不能留下 rejected connecting promise 污染后续 snapshot。
    return await this.failConnection({
      config: input.config,
      error,
      failureKind: "oauth_authorization_failed",
      generation: input.generation,
      name: input.name,
      startedAt,
    });
  }
}

/**
 * Phase 2：交互授权。
 *
 * 授权事务的寿命是 300 秒，与 caller 的等待预算（session 15 秒）无关；caller 侧的收口发生在
 * `connectServer` / `waitForSharedConnection`，本方法不感知 caller 预算。
 */
export async function runInteractiveOAuthAuthorization(
  this: McpOAuthRecoveryContext,
  input: {
    config: Extract<McpServerConfig, { type: "http" | "sse" }>;
    generation: number;
    name: string;
    oauthConfig: AuthorizationCodeOAuthConfig;
    serverUrl: string;
    signal: AbortSignal;
    trigger: InteractiveAuthorizationTrigger;
  },
): Promise<McpInteractiveAuthorizationOutcome> {
  try {
    const oauthOptions = this.createAuthorizationCodeOAuthOptions(
      input.config,
      input.name,
      input.generation,
    );
    const credentialStore = oauthOptions?.credentialStore ?? createSharedLCodeCredentialStore();
    const keyPrefix = createCredentialKeyPrefix(input.name, input.serverUrl, input.oauthConfig);
    // 403 step-up 的最终 scope 必须是 config ∪ token.scope ∪ challenge
    // 的并集。只带 challenge scope 重新授权时，授权服务器可能按新请求收回先前授予的 scope，
    // 下一个请求换个 challenge 又 403，形成重授权乒乓。token response 的 scope 允许缺失
    // （RFC 6749 §3.3），所以配置里声明过的 scope 必须显式并入，不能只看 token 回显。
    let requestedScope: string | undefined = input.oauthConfig.scope;
    if (input.trigger.requiredScope) {
      const currentPair = await loadCredentialPair(credentialStore, keyPrefix);
      requestedScope = computeScopeUnion(
        input.oauthConfig.scope,
        currentPair?.tokens?.scope,
        input.trigger.requiredScope,
      );
    }
    return await runMcpInteractiveAuthorization({
      adapterInstanceId: this.adapterInstanceId,
      config: input.oauthConfig,
      credentialStore,
      fetchFn: createMcpTransportFetch({ env: this.env, network: this.network }),
      // 403 step-up：requiredScope 是当前 token scope 的严格超集时 refresh 无法扩权
      // （RFC 6749 §6），必须强制重新授权，否则新 scope 会被静默丢弃并再次 403。
      ...(input.trigger.reason === "insufficient_scope" ? { forceReauthorization: true } : {}),
      keyPrefix,
      logger: this.logger,
      ...(oauthOptions?.onAuthorizationRequired
        ? { onAuthorizationRequired: oauthOptions.onAuthorizationRequired }
        : {}),
      ...(oauthOptions?.openAuthorizationUrl
        ? { openAuthorizationUrl: oauthOptions.openAuthorizationUrl }
        : {}),
      ...(requestedScope ? { requestedScope } : {}),
      ...(input.trigger.resourceMetadataUrl
        ? { resourceMetadataUrl: new URL(input.trigger.resourceMetadataUrl) }
        : {}),
      serverName: input.name,
      serverUrl: input.serverUrl,
      signal: input.signal,
      transactionTtlMs: MCP_OAUTH_AUTHORIZATION_TRANSACTION_TTL_MS,
    });
  } catch (error) {
    // 本方法的返回类型已经把编排失败建模为 outcome。过去 credential load、
    // authz lease 或 follower callback 的异常会裸 reject，绕过 failConnection，留下
    // status=connecting + rejected record.connecting，并让 connectConfiguredServers 整批失败。
    this.logger?.warn("MCP OAuth authorization orchestration failed", {
      error: error instanceof Error ? error.message : String(error),
      errorName: error instanceof Error ? error.name : "unknown",
      event: "mcp.oauth.authorization.orchestration_failed",
      mcpServerName: input.name,
      status: "failed",
    });
    return { status: "failed", error };
  }
}
