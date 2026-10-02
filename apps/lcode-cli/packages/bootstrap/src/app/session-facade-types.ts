import { type ConfigResult } from "@lcode/adapters/config";
import type { AgentRuntime } from "@lcode/core";
import { type ModelSelection } from "@lcode/provider";
import {
  type ExecutionPort,
  type Logger,
  type LoggerFactory,
  type LocalSettingStorePort,
  type McpPort,
  type McpServerConfig,
  type ProjectId,
  type SessionId,
  type SessionStorePort,
  type SupportedLocale,
  type TraceContext,
  type UiLocale,
} from "@lcode/contracts";
import type {
  ProviderRegistryModelSource,
  RuntimeModelFactory,
} from "./provider-registry-model-runtime.js";
import type { PrepareUserExecutionBoundary, LCodeApp } from "./types.js";

export type SessionFacade = Pick<
  LCodeApp,
  | "readBackgroundBashOutput"
  | "cancelBackgroundTask"
  | "clearTarget"
  | "close"
  | "connectMcpServer"
  | "disconnectMcpServer"
  | "generateWorkspaceText"
  | "testModelConnectivity"
  | "forkFromCheckpoint"
  | "getMode"
  | "getModel"
  | "getCurrentModelOption"
  | "getModelOption"
  | "getLocale"
  | "getDefaultThoughtLevel"
  | "getThoughtLevel"
  | "getTheme"
  | "listCheckpoints"
  | "listMcpServers"
  | "listModels"
  | "listThoughtLevels"
  | "loadSessionTranscript"
  | "readSubagents"
  | "readSubagentTranscript"
  | "readTodos"
  | "readTarget"
  | "setCustomSessionTitle"
  | "setMode"
  | "setModel"
  | "setThoughtLevel"
  | "setLocale"
  | "setTarget"
  | "updateTargetStatus"
>;

export interface CreateSessionFacadeDeps {
  /**
   * 停下本会话拥有的 dwf run：
   * run service 的 `close()`。缺席即本装配没有 dwf 端口（journal 窄化失败、测试装配）。
   */
  closeDynamicWorkflowRuns?: () => Promise<void>;
  closeNodeReplBrowserBroker?: () => Promise<void> | undefined;
  configResult: ConfigResult;
  configuredMcpServers: Record<string, McpServerConfig>;
  configuredDefaultModelSelection?: ModelSelection;
  executionPort: ExecutionPort;
  localSettingStore?: LocalSettingStorePort;
  logger: Logger;
  loggerFactory: LoggerFactory;
  mcpPort?: McpPort;
  ownsExecutionPort: boolean;
  ownsMcpPort: boolean;
  ownsSessionStore: boolean;
  prepareUserExecutionBoundary: PrepareUserExecutionBoundary;
  prepareResume(traceContext?: TraceContext): Promise<void>;
  projectID: ProjectId;
  providerRegistry: ProviderRegistryModelSource;
  temporaryModelFactory?: RuntimeModelFactory;
  resolveUiLocale(locale: UiLocale): SupportedLocale;
  runtime: AgentRuntime;
  sessionResourceCloseTimeoutMs?: number;
  sessionId: SessionId;
  sessionStore: SessionStorePort;
  traceContext: TraceContext;
  untrustedProjectMcpServers: Set<string>;
  workingDirectory: string;
}
