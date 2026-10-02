import type { AuthProvider, OAuthClientProvider } from "@modelcontextprotocol/client";
import type {
  Logger,
  McpCallToolOptions,
  McpCallToolRequest,
  McpConnectOptions,
  McpConnectionSnapshot,
  McpPort,
  McpServerConfig,
  McpServerStatus,
  McpToolCallResult,
  McpToolDescriptor,
} from "@lcode/contracts";
import type { McpServerFailureKind, OfficialMcpAuthFailureKind } from "@lcode/shared";
import type { SharedLCodeCredentialStore } from "../auth/shared-credentials.js";
import type { InteractiveAuthorizationTrigger } from "./oauth-errors.js";
import type { McpInteractiveAuthorizationOutcome } from "./oauth-interactive.js";
import type { McpOAuthRuntimeOptions } from "./oauth.js";
import type { OfficialMcpServerResponseInfo } from "./official-auth.js";
import type { NetworkEgressEnvPolicy } from "./network.js";
import type { McpConnectionContext } from "./pool.js";
import type { McpTelemetryTracker } from "./telemetry.js";
import type { McpDeadline } from "./timeout.js";
import type {
  AuthorizationCodeOAuthConfig,
  CreateMcpAdapterOptions,
  McpClient,
  McpServerRecord,
  McpTransport,
  OfficialMcpAuthMetaPayload,
} from "./adapter-types.js";

// 所有可变连接状态只属于 NodeMcpAdapter；执行函数借用这些引用，不创建第二份状态。
export interface McpAdapterOwner extends McpPort {
  readonly adapterInstanceId: string;
  readonly clientName: string;
  readonly clientVersion: string;
  readonly connectionContext?: McpConnectionContext;
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: Logger;
  readonly mcpOAuth?: McpOAuthRuntimeOptions;
  readonly network?: NetworkEgressEnvPolicy;
  readonly officialMcpAuth?: CreateMcpAdapterOptions["officialMcpAuth"];
  readonly telemetry?: McpTelemetryTracker;
  readonly connectionGenerations: Map<string, number>;
  credentialStore?: SharedLCodeCredentialStore;
  readonly lastOfficialAuthKind: Map<string, OfficialMcpAuthFailureKind>;
  readonly serverRequestIdBySpan: Map<string, string>;
  readonly connectionDiagnosticByServer: Map<
    string,
    Pick<McpServerStatus, "failureKind" | "serverRequestId">
  >;
  readonly records: Map<string, McpServerRecord>;
  readonly workingDirectory?: string;

  connectConfiguredServers(
    servers: Record<string, McpServerConfig>,
    options?: McpConnectOptions,
  ): Promise<McpConnectionSnapshot>;

  connectServer(
    name: string,
    config: McpServerConfig,
    options?: McpConnectOptions,
  ): Promise<McpServerStatus>;

  disconnectServer(name: string): Promise<McpServerStatus | undefined>;

  status(): Promise<Record<string, McpServerStatus>>;

  pingServer(name: string, options?: { timeoutMs?: number }): Promise<boolean>;

  listTools(): Promise<McpToolDescriptor[]>;

  callTool(request: McpCallToolRequest, options?: McpCallToolOptions): Promise<McpToolCallResult>;

  rememberServerResponse(serverName: string, response: OfficialMcpServerResponseInfo): void;

  takeServerRequestId(spanId: string | undefined): string | undefined;

  resolveOfficialStdioAuthMeta(
    serverName: string,
    config: McpServerConfig,
    signal: AbortSignal | undefined,
  ): Promise<OfficialMcpAuthMetaPayload | undefined>;

  callToolOnClient(
    client: McpClient,
    request: McpCallToolRequest,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<McpToolCallResult>;

  reconnectForCall(name: string, config: McpServerConfig): Promise<void>;

  recoverToolCallAuthorization(input: {
    deadline: McpDeadline;
    error: unknown;
    record: McpServerRecord;
    request: McpCallToolRequest;
    signal?: AbortSignal;
    timeoutMessage: string;
    trigger: InteractiveAuthorizationTrigger;
  }): Promise<McpToolCallResult>;

  ensureToolCallAuthorizationRecovery(input: {
    config: Extract<McpServerConfig, { type: "http" | "sse" }>;
    name: string;
    oauthConfig: AuthorizationCodeOAuthConfig;
    record: McpServerRecord;
    trigger: InteractiveAuthorizationTrigger;
  }): Promise<McpServerStatus>;

  runToolCallAuthorizationRecovery(input: {
    abortController: AbortController;
    config: Extract<McpServerConfig, { type: "http" | "sse" }>;
    generation: number;
    name: string;
    oauthConfig: AuthorizationCodeOAuthConfig;
    previousClient?: McpClient;
    previousTransport?: McpTransport;
    trigger: InteractiveAuthorizationTrigger;
  }): Promise<McpServerStatus>;

  close(): Promise<void>;

  waitForSharedConnection(
    name: string,
    record: McpServerRecord,
    options: McpConnectOptions,
  ): Promise<McpServerStatus>;

  openServerConnection(input: {
    config: McpServerConfig;
    generation: number;
    name: string;
    oauthAuthorizationTimeoutMs?: number;
    signal: AbortSignal;
    timeoutMs: number;
    workingDirectory?: string;
    oauthAuthorizationAttempted?: boolean;
  }): Promise<McpServerStatus>;

  runInteractiveOAuthAuthorization(input: {
    config: Extract<McpServerConfig, { type: "http" | "sse" }>;
    generation: number;
    name: string;
    oauthConfig: AuthorizationCodeOAuthConfig;
    serverUrl: string;
    signal: AbortSignal;
    trigger: InteractiveAuthorizationTrigger;
  }): Promise<McpInteractiveAuthorizationOutcome>;

  failConnection(input: {
    client?: McpClient;
    config: McpServerConfig;
    connectDurationMs?: number;
    error: unknown;
    failureKind?: McpServerFailureKind;
    generation: number;
    getRecentStderr?: () => string | undefined;
    listToolsDurationMs?: number;
    name: string;
    startedAt: number;
    transport?: McpTransport;
  }): Promise<McpServerStatus>;

  createTransport(
    config: McpServerConfig,
    serverName: string,
    generation: number,
    _oauthAuthorizationTimeoutMs?: number,
    workingDirectory?: string,
    signal?: AbortSignal,
  ): Promise<{ transport: McpTransport }>;

  createOfficialAuthFetch(
    config: McpServerConfig,
    serverName: string,
    generation: number,
  ): typeof globalThis.fetch | undefined;

  createOAuthClientProvider(
    serverName: string,
    config: McpServerConfig,
  ): AuthProvider | OAuthClientProvider | undefined;

  resolveCredentialStore(): SharedLCodeCredentialStore;

  createAuthorizationCodeOAuthOptions(
    config: McpServerConfig,
    serverName: string,
    generation: number,
    oauthAuthorizationTimeoutMs?: number,
  ): McpOAuthRuntimeOptions | undefined;

  attachStdioLogging(name: string, transport: McpTransport): () => string | undefined;

  closeRecord(name: string): Promise<void>;

  closeClientAndTransport(
    name: string,
    client?: McpClient,
    transport?: McpTransport,
  ): Promise<void>;

  terminateStdioProcessTree(name: string, transport?: McpTransport): Promise<void>;

  nextConnectionGeneration(name: string): number;

  isCurrentConnection(name: string, generation: number): boolean;

  updateCurrentRecord(
    name: string,
    generation: number,
    patch: Partial<Pick<McpServerRecord, "client" | "transport">>,
  ): void;

  updateCurrentRecordStatus(
    name: string,
    generation: number,
    patch: Partial<McpServerStatus>,
  ): void;

  createStatus(
    config: McpServerConfig,
    status: McpServerStatus["status"],
    extra?: {
      authorization?: McpServerStatus["authorization"];
      error?: string;
      failureKind?: McpServerStatus["failureKind"];
      protocolEra?: McpServerStatus["protocolEra"];
      serverRequestId?: string;
      toolCount?: number;
    },
  ): McpServerStatus;
}
