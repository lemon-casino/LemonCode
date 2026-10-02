import type {
  McpCallToolOptions,
  McpCallToolRequest,
  McpContentBlock,
  McpServerConfig,
  McpToolCallResult,
} from "@lcode/contracts";
import { LCODE_MCP_SERVER_REQUEST_ID_META_KEY } from "@lcode/contracts";
import { DEFAULT_MCP_TIMEOUT_MS, type McpClient, type McpServerRecord } from "./adapter-types.js";
import {
  isRecord,
  mcpRequestMeta,
  resolveAuthorizationCodeOAuthConfig,
} from "./adapter-protocol.js";
import {
  classifyInteractiveAuthorizationTrigger,
  type InteractiveAuthorizationTrigger,
} from "./oauth-errors.js";
import {
  createMcpDeadline,
  remainingMcpDeadlineMs,
  waitWithinMcpDeadline,
  type McpDeadline,
} from "./timeout.js";

import type { McpAdapterOwner } from "./adapter-owner.js";

type McpCallsContext = Pick<
  McpAdapterOwner,
  | "records"
  | "reconnectForCall"
  | "callToolOnClient"
  | "recoverToolCallAuthorization"
  | "logger"
  | "takeServerRequestId"
  | "connectServer"
  | "ensureToolCallAuthorizationRecovery"
>;

export async function callTool(
  this: McpCallsContext,
  request: McpCallToolRequest,
  options: McpCallToolOptions = {},
): Promise<McpToolCallResult> {
  const initialRecord = this.records.get(request.serverName);
  const timeoutMs = options.timeoutMs ?? initialRecord?.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  const deadline = createMcpDeadline(timeoutMs);
  const timeoutMessage = `MCP tool ${request.serverName}/${request.toolName} timed out after ${timeoutMs}ms`;
  const pending = initialRecord?.connecting;
  if (pending) {
    // connecting 是 adapter 持有的共享连接/OAuth 恢复任务。过去这里裸 await，
    // tool caller 的 timeout/abort 完全失效；但直接 abort 底层任务又会关闭其他 caller 共用的
    // callback listener。这里只限制当前 waiter，共享任务继续由 record 生命周期持有。
    await waitWithinMcpDeadline(pending, deadline, timeoutMessage, options.signal);
  }

  // stdio MCP 子进程死亡后（如 node_repl 被异步错误击穿），此前没有任何恢复路径：
  // 连接只在 session 创建时建立一次，session resume 也不重建，该会话的工具从此永远失败。
  // 这里在调用前对已断连的 record 重连一次；server 进程内状态（如 REPL 变量）不可恢复，
  // 但工具本身恢复可用。
  const disconnected = this.records.get(request.serverName);
  if (disconnected && disconnected.status.status === "disconnected") {
    await waitWithinMcpDeadline(
      this.reconnectForCall(request.serverName, disconnected.config),
      deadline,
      timeoutMessage,
      options.signal,
    );
  }

  const record = this.records.get(request.serverName);
  if (!record?.client || record.status.status !== "connected") {
    throw new Error(`MCP server is not connected: ${request.serverName}`);
  }

  try {
    return await this.callToolOnClient(
      record.client,
      request,
      remainingMcpDeadlineMs(deadline, timeoutMessage),
      options.signal,
    );
  } catch (error) {
    // 连接建立后 token 过期、被撤销或 scope 不足时，
    // 过去这些认证错误原样冒泡，用户看到裸错误且永远不会自愈——OAuth 自愈只存在于
    // startup connect 路径。现在运行期与建连期共用同一套 Phase 2 → Phase 1 编排。
    const trigger = classifyInteractiveAuthorizationTrigger(error);
    if (trigger && record.config.type !== "stdio") {
      return await this.recoverToolCallAuthorization({
        error,
        record,
        request,
        deadline,
        timeoutMessage,
        trigger,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    }
    // 防 onclose 尚未派发的竞态：SDK 在 transport 已断时抛裸 "Not connected"。
    // 只对这一种确定的断连错误重连重试一次，其余错误原样冒泡。
    if (!(error instanceof Error) || error.message !== "Not connected") throw error;
    try {
      await waitWithinMcpDeadline(
        this.reconnectForCall(request.serverName, record.config),
        deadline,
        timeoutMessage,
        options.signal,
      );
    } catch (reconnectError) {
      this.logger?.warn("MCP server reconnect failed", {
        error: reconnectError instanceof Error ? reconnectError.message : String(reconnectError),
        event: "mcp.server.reconnect.failed",
        mcpServerName: request.serverName,
        status: "failed",
      });
      throw error;
    }
    const revived = this.records.get(request.serverName);
    if (!revived?.client || revived.status.status !== "connected") throw error;
    return await this.callToolOnClient(
      revived.client,
      request,
      remainingMcpDeadlineMs(deadline, timeoutMessage),
      options.signal,
    );
  }
}

export async function callToolOnClient(
  this: McpCallsContext,
  client: McpClient,
  request: McpCallToolRequest,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<McpToolCallResult> {
  // 工具调用此前完全无日志：超时时既看不到预算是多少，也无法区分"服务端慢"与
  // "客户端预算太小"。这里记录预算与耗时，但只记参数的 key（值可能是用户输入）。
  const logBase = {
    event: "mcp.tool.call",
    mcpServerName: request.serverName,
    mcpToolName: request.toolName,
    module: "adapters.mcp",
    timeoutMs,
  };
  const argumentKeys = Object.keys(request.arguments ?? {}).sort();
  this.logger?.debug("MCP tool call started", {
    ...logBase,
    argumentKeys,
    status: "started",
  });

  const startedAt = Date.now();
  try {
    const result = await client.callTool(
      {
        name: request.toolName,
        arguments: request.arguments ?? {},
        ...(request.trace || request.runtimeScope || request.workspaceKey || request.workspacePath
          ? { _meta: mcpRequestMeta(request) }
          : {}),
      },
      {
        signal,
        timeout: timeoutMs,
        resetTimeoutOnProgress: true,
      },
    );

    const durationMs = Date.now() - startedAt;
    const isError = typeof result.isError === "boolean" ? result.isError : false;
    // 官方 MCP 的 in-band 失败（配额耗尽、无套餐）是 HTTP 200 + isError，wrapper 那条
    // 非 2xx warn 覆盖不到；request id 也只有 wrapper 能看到，所以在这里按 span 取回。
    const serverRequestId = this.takeServerRequestId(request.trace?.spanId);
    const outcome = {
      ...logBase,
      contentBlocks: Array.isArray(result.content) ? result.content.length : 0,
      durationMs,
      hasStructuredContent: result.structuredContent !== undefined,
      // 业务级失败（isError）与传输级失败不同，必须能分开统计。
      isError,
      ...(serverRequestId ? { serverRequestId } : {}),
    };
    if (isError) {
      // 之前 in-band 失败只有这条 debug，而生产 logger 最低级别是 Info——等于配额耗尽
      // 这类失败在生产日志里完全不可见。
      this.logger?.warn("MCP tool returned an error", { ...outcome, status: "failed" });
    } else {
      this.logger?.debug("MCP tool call completed", { ...outcome, status: "completed" });
    }

    const meta = isRecord(result._meta) ? result._meta : undefined;
    return {
      content: Array.isArray(result.content)
        ? (result.content as McpContentBlock[])
        : [{ type: "text", text: "" }],
      structuredContent: result.structuredContent,
      isError: typeof result.isError === "boolean" ? result.isError : undefined,
      // 只在失败时附加：成功路径上它是纯噪声。服务端已给的键一律不覆盖。
      _meta:
        isError && serverRequestId
          ? { ...meta, [LCODE_MCP_SERVER_REQUEST_ID_META_KEY]: serverRequestId }
          : meta,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    // 判定是否为超时：SDK 超时会抛 MCP error code -32001 (RequestTimeout)，
    // 底层 fetch abort 抛 AbortError。两者都要能一眼认出，否则只能看到裸 message。
    const timedOut =
      /timed?\s*out|timeout/i.test(message) ||
      (error instanceof Error && error.name === "AbortError");
    // 传输级失败也带上：4xx/5xx 时 SDK 抛出的 message 里没有 request id。
    const serverRequestId = this.takeServerRequestId(request.trace?.spanId);
    this.logger?.warn("MCP tool call failed", {
      ...logBase,
      argumentKeys,
      durationMs,
      error: message,
      ...(serverRequestId ? { serverRequestId } : {}),
      errorName: error instanceof Error ? error.name : "unknown",
      status: "failed",
      timedOut,
      // 耗时贴着预算 ⇒ 是我们掐断的；远小于预算 ⇒ 是对端或网络断的。
      ...(timedOut ? { budgetExhausted: durationMs >= timeoutMs * 0.9 } : {}),
    });
    throw error;
  }
}

export async function reconnectForCall(
  this: McpCallsContext,
  name: string,
  config: McpServerConfig,
): Promise<void> {
  this.logger?.warn("MCP server reconnecting after lost connection", {
    event: "mcp.server.reconnect.started",
    mcpServerName: name,
    status: "started",
    transport: config.type,
  });
  await this.connectServer(name, config);
}

/**
 * 运行期认证恢复：Phase 2 交互授权 → Phase 1 重连 → 原 tool call 最多安全重试一次。
 *
 * 与建连期共用 `runInteractiveOAuthAuthorization`，因此单飞、fencing、caller 预算语义完全一致。
 */
export async function recoverToolCallAuthorization(
  this: McpCallsContext,
  input: {
    deadline: McpDeadline;
    error: unknown;
    record: McpServerRecord;
    request: McpCallToolRequest;
    signal?: AbortSignal;
    timeoutMessage: string;
    trigger: InteractiveAuthorizationTrigger;
  },
): Promise<McpToolCallResult> {
  const { record, request } = input;
  const config = record.config;
  if (config.type === "stdio") throw input.error;
  const oauthConfig = resolveAuthorizationCodeOAuthConfig(config);
  if (!oauthConfig) throw input.error;

  this.logger?.warn("MCP tool call requires OAuth authorization", {
    event: "mcp.oauth.tool_call.authorization_required",
    mcpServerName: request.serverName,
    oauthTriggerReason: input.trigger.reason,
    status: "started",
    toolName: request.toolName,
  });

  const recovery = this.ensureToolCallAuthorizationRecovery({
    config,
    name: request.serverName,
    oauthConfig,
    record,
    trigger: input.trigger,
  });
  const recoveredStatus = await waitWithinMcpDeadline(
    recovery,
    input.deadline,
    input.timeoutMessage,
    input.signal,
  );
  if (recoveredStatus.status !== "connected") {
    throw input.error;
  }

  const revived = this.records.get(request.serverName);
  if (!revived?.client || revived.status.status !== "connected") throw input.error;
  return await this.callToolOnClient(
    revived.client,
    request,
    remainingMcpDeadlineMs(input.deadline, input.timeoutMessage),
    input.signal,
  );
}
