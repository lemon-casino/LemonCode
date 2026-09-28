import type {
  LCodeAgentMcpServer,
  LCodeAutomationScheduleRule,
  LCodeMcpListMode,
  ModelSelection,
} from "@lcode/shared";

export interface LCodeAgentWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 远程 workspace 的运行时会话身份；只用于隔离/路由，不能替代 workspacePath。 */
  remoteSessionId?: string;
}

export interface LCodeAgentPluginViewParams extends LCodeAgentWorkspaceTarget {
  configScope?: "user" | "workspace";
}

export interface LCodeAgentListMcpServerStatusesParams extends LCodeAgentWorkspaceTarget {
  mcpServers?: LCodeAgentMcpServer[];
  mode?: LCodeMcpListMode;
}

export interface LCodeAgentAddPluginMarketplaceParams extends LCodeAgentWorkspaceTarget {
  dryRun?: boolean;
  operationId?: string;
  source: string;
}

export interface LCodeAgentRemovePluginMarketplaceParams extends LCodeAgentWorkspaceTarget {
  marketplace: string;
}

export interface LCodeAgentUpdatePluginMarketplaceParams extends LCodeAgentWorkspaceTarget {
  marketplace?: string;
  operationId?: string;
}

export interface LCodeAgentInstallPluginParams extends LCodeAgentWorkspaceTarget {
  dryRun?: boolean;
  marketplace: string;
  operationId?: string;
  pluginName: string;
  scope?: "user" | "workspace";
}

export interface LCodeAgentCancelPluginOperationParams {
  operationId: string;
}

export interface LCodeAgentUninstallPluginParams extends LCodeAgentWorkspaceTarget {
  marketplace?: string;
  pluginId?: string;
  pluginName?: string;
  removeCache?: boolean;
}

export interface LCodeAgentUpdatePluginParams extends LCodeAgentWorkspaceTarget {
  pluginId?: string;
  marketplace?: string;
}

export interface LCodeAgentRestoreBuiltinPluginParams extends LCodeAgentWorkspaceTarget {
  pluginId: string;
}

export interface LCodeAgentConfigurePluginParams extends LCodeAgentWorkspaceTarget {
  clearOptionKeys?: string[];
  dryRun?: boolean;
  options: Record<string, unknown>;
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface LCodeAgentResetPluginConfigParams extends LCodeAgentWorkspaceTarget {
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface LCodeAgentValidatePluginParams extends LCodeAgentWorkspaceTarget {
  marketplace?: string;
  pluginName?: string;
  source?: string;
}

export interface LCodeAgentDescribePluginParams extends LCodeAgentWorkspaceTarget {
  marketplace: string;
  pluginName: string;
}

export interface LCodeAgentSetPluginEnabledParams extends LCodeAgentWorkspaceTarget {
  enabled: boolean;
  operationId?: string;
  pluginId: string;
  scope?: "user" | "workspace";
}

// Plugin 对话引用 catalog：
// 带 sessionId → session-owned 冻结 catalog（必须路由到持有该 session 的 workspace client）；
// 不带 → workspace 当前 catalog（新建草稿 Picker）。
export interface LCodeAgentPluginReferenceCatalogParams extends LCodeAgentWorkspaceTarget {
  sessionId?: string;
}

// Composer Skill catalog：与 Plugin 引用相同，以 sessionId 区分 workspace 当前目录和
// resident Session runtime 快照；不参与 Settings 管理目录。
export interface LCodeAgentSkillReferenceCatalogParams extends LCodeAgentWorkspaceTarget {
  sessionId?: string;
}
export interface LCodeAgentResolveSuggestedPluginReferenceParams extends LCodeAgentWorkspaceTarget {
  stableId: string;
  operationId: string;
  clientMode: "desktop-continuous" | "web-remote-replayable";
  deliveryKind: "desktop-continuous" | "web-remote-replayable";
}

// ---- 定时任务(automation)管理参数 ----

export interface LCodeAgentCreateAutomationParams extends LCodeAgentWorkspaceTarget {
  title: string;
  cronExpr: string;
  relativeDelayMinutes?: number;
  prompt: string;
  modelSelection?: ModelSelection;
  mode?: string;
  recurring?: boolean;
  maxRuns?: number;
  endAt?: number;
  scheduleRule?: LCodeAutomationScheduleRule;
}

export interface LCodeAgentUpdateAutomationParams extends LCodeAgentWorkspaceTarget {
  automationId: string;
  title?: string;
  cronExpr?: string;
  prompt?: string;
  modelSelection?: ModelSelection | null;
  mode?: string | null;
  recurring?: boolean;
  maxRuns?: number | null;
  endAt?: number | null;
  scheduleRule?: LCodeAutomationScheduleRule | null;
  scheduleEditedByUser?: boolean;
}

export interface LCodeAgentAutomationIdParams extends LCodeAgentWorkspaceTarget {
  automationId: string;
}

export interface LCodeAgentSetAutomationEnabledParams extends LCodeAgentWorkspaceTarget {
  automationId: string;
  enabled: boolean;
}

export interface LCodeAgentDeleteAutomationRunParams extends LCodeAgentWorkspaceTarget {
  runId: string;
}
