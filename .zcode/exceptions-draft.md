
## 例外清单（`git grep -I -i zcode` 全仓残余，自动分类于迁移执行时）

### 转义域名正则 / 旧数据字段键 / bizCode 误报 / 外部包名识别串 —— 30 行 / 8 文件
- apps/lcode-cli/packages/adapters/src/config/schema.ts（1 行）
- config/provider/lcode-builtin.json（3 行）
- packages/lcode-cua/broker-server.js（1 行）
- packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts（1 行）
- packages/services/src/model-provider/legacyLCodeConfigProviderReader.ts（4 行）
- packages/services/src/session/offPeakServerClient.ts（3 行）
- packages/services/src/session/offPeakTaskService.ts（3 行）
- packages/shared/src/mcp.ts（14 行）

### 外部域名族 zcode.z.ai / zcode-plan 网关路径 —— 43 行 / 28 文件
- .env.example（4 行）
- apps/lcode-cli/packages/adapters/src/auth/cli-oauth.ts（1 行）
- apps/lcode-cli/packages/adapters/src/model/model-execution.ts（2 行）
- apps/lcode-cli/packages/adapters/src/model/official-coding-plan-gateway.ts（1 行）
- apps/lcode-cli/packages/adapters/src/model/provider-finish-business-error.ts（1 行）
- apps/lcode-cli/packages/adapters/src/model/runner-options.ts（2 行）
- apps/lcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts（1 行）
- apps/lcode-cli/packages/bootstrap/src/lcode-protocol/provider-runtime-headers.ts（1 行）
- apps/lcode-cli/packages/core/src/runtime/helpers/model-errors.ts（1 行）
- apps/lcode-cli/packages/core/src/runtime/methods/model.ts（1 行）
- config/provider/lcode-builtin.json（4 行）
- packages/desktop/electron-builder.config.js（3 行）
- packages/desktop/src/main/networkTelemetryAggregator.ts（1 行）
- packages/desktop/src/main/remoteCdn.ts（1 行）
- packages/services/src/conversation-share/conversationShareService.ts（1 行）
- packages/services/src/model-provider/legacyLCodeConfigProviderReader.ts（1 行）
- packages/services/src/oauth/providers/bigmodelProviderConfig.ts（1 行）
- packages/services/src/oauth/providers/zaiProviderConfig.ts（1 行）
- packages/shared/src/lcodeEndpoint.ts（5 行）
- packages/shared/src/plugin-marketplaces.ts（1 行）
- packages/ui/src/lib/lcodeUiError.ts（1 行）
- packages/ui/src/lib/productDocs.ts（1 行）
- packages/ui/src/lib/providerBusinessError.ts（1 行）
- packages/ui/src/lib/rendererLCodeEndpoint.ts（1 行）
- packages/ui/src/settings/CodingPlanEmbeddedWebviewDialog.tsx（1 行）
- packages/ui/src/settings/model-provider-section/codingPlanEmbeddedWebview.ts（2 行）
- packages/ui/src/v4/featureSuggestedPrompts.ts（1 行）
- packages/web/src/share/ConversationShareLandingPage.tsx（1 行）

### 上游指认 zai-org/ZCode —— 5 行 / 1 文件
- README.md（5 行）

### MCP 命名空间 com.zcode/*（含 Go 侧） —— 11 行 / 7 文件
- apps/lcode-cli/packages/adapters/src/mcp/index.ts（1 行）
- apps/lcode-cli/packages/adapters/src/mcp/official-auth.ts（1 行）
- apps/lcode-cli/packages/contracts/src/interfaces/mcp.port.ts（3 行）
- apps/lcode-cli/packages/node-repl-host/src/server.ts（1 行）
- packages/lcode-cua/broker.test.js（2 行）
- packages/lcode-cua/e2e-packaged-node-repl.mjs（1 行）
- packages/shared/src/official-mcp-auth.ts（2 行）

### 插件市场 ID zcode-plugins-official —— 115 行 / 23 文件
- CONTEXT.md（1 行）
- apps/lcode-cli/README.md（2 行）
- apps/lcode-cli/packages/adapters/src/config/schema.ts（1 行）
- apps/lcode-cli/packages/bootstrap/src/lcode-protocol/plugin-reference-catalog.ts（2 行）
- apps/lcode-cli/packages/bootstrap/src/plugins.ts（2 行）
- apps/lcode-cli/packages/cli/scripts/sea-official-plugin-assets.mjs（4 行）
- apps/lcode-cli/packages/contracts/src/plugins/index.ts（1 行）
- packages/lcode-cua/broker-server.js（1 行）
- packages/lcode-cua/broker-server.test.js（7 行）
- packages/lcode-cua/e2e-packaged-node-repl.mjs（1 行）
- packages/services/src/commands/commandsService.ts（1 行）
- packages/services/src/skills/skillsService.ts（1 行）
- packages/shared/src/mcp.ts（1 行）
- packages/shared/src/node/officialPluginCache.ts（1 行）
- packages/shared/src/plugin-marketplaces.ts（12 行）
- packages/ui/src/lib/builtinSkillI18n.ts（2 行）
- packages/ui/src/lib/pluginIconSource.ts（6 行）
- packages/ui/src/settings/BrowserSettingsSection.tsx（1 行）
- packages/ui/src/settings/pluginCreatorPrefill.ts（1 行）
- packages/ui/src/v4/featureSuggestedPrompts.ts（59 行）
- scripts/computer-use-plugin-builtin.test.mjs（5 行）
- scripts/lemon-workflow-builtin.test.mjs（1 行）
- specs/computer-use-open-replacement.md（2 行）

### 外部包名 zcode_cua / zcode-cua.server / zcode-api-key —— 4 行 / 3 文件
- apps/lcode-cli/packages/adapters/src/auth/coding-plan-api-key.ts（1 行）
- packages/services/src/model-provider/accountProviderApiTypes.ts（1 行）
- packages/shared/src/mcp.ts（2 行）

### 官网跨站契约 zcodeBridge / __zcodeLang__ / zcode-coding-plan-lang-change / zcode:coding-plan:embedded / 注入页 zcode-theme —— 26 行 / 6 文件
- packages/desktop/src/main/desktopWindowChrome.ts（3 行）
- packages/desktop/src/preload/codingPlanWebview.ts（8 行）
- packages/shared/src/channels.ts（3 行）
- packages/ui/src/settings/CodingPlanEmbeddedWebviewDialog.tsx（2 行）
- packages/ui/src/settings/CodingPlanUpgradeDialog.tsx（1 行）
- packages/ui/src/settings/model-provider-section/codingPlanEmbeddedWebview.ts（9 行）

### 持久化枚举/数据标识 "zcode" / zcodeagentmcp / provider.zcode / model.zcode / localStorage:zcode-mcp-config / __zcode_internal —— 84 行 / 35 文件
- apps/lcode-cli/packages/adapters/src/auth/bigmodel-oauth.ts（1 行）
- apps/lcode-cli/packages/adapters/src/commands/roots.ts（2 行）
- apps/lcode-cli/packages/adapters/src/skills/roots.ts（2 行）
- apps/lcode-cli/packages/contracts/src/commands/index.ts（1 行）
- apps/lcode-cli/packages/contracts/src/skills/index.ts（1 行）
- packages/desktop/src/main/mcpUserDirectory/index.ts（3 行）
- packages/desktop/src/main/mcpUserDirectory/types.ts（1 行）
- packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts（1 行）
- packages/services/src/commands/commandsService.ts（2 行）
- packages/services/src/hooks/hooksService.ts（8 行）
- packages/services/src/hooks/workspaceHookSettingsModel.ts（1 行）
- packages/services/src/mcp-sync/mcpSyncService.ts（4 行）
- packages/services/src/model-provider/legacyLCodeConfigProviderReader.ts（8 行）
- packages/services/src/oauth/providers/bigmodelProviderConfig.ts（1 行）
- packages/shared/src/lcode-protocol-v4/telemetry.ts（1 行）
- packages/shared/src/lcode-task-types-core.ts（2 行）
- packages/shared/src/mcp-sync.ts（1 行）
- packages/shared/src/mcp.ts（2 行）
- packages/shared/src/settings-source.ts（1 行）
- packages/shared/src/settings-sync.ts（1 行）
- packages/ui/src/lib/messageTelemetry.ts（1 行）
- packages/ui/src/settings-sync/SettingsSyncSelectionStep.tsx（1 行）
- packages/ui/src/settings/CommandCard.tsx（1 行）
- packages/ui/src/settings/ExternalAgentImportDialog.tsx（1 行）
- packages/ui/src/settings/HooksSection.tsx（2 行）
- packages/ui/src/settings/McpServerList.tsx（1 行）
- packages/ui/src/settings/McpSettingsSection.tsx（5 行）
- packages/ui/src/settings/mcpSettingsShared.ts（3 行）
- packages/ui/src/settings/pluginManagedResourceGroups.ts（1 行）
- packages/ui/src/store/hooksStore.ts（4 行）
- packages/ui/src/store/mcpStore.ts（11 行）
- packages/ui/src/store/mcpStoreHelpers.ts（2 行）
- packages/ui/src/store/mcpStoreMigration.ts（4 行）
- packages/ui/src/store/mcpStoreStatusList.ts（1 行）
- packages/web/src/auth/webZaiOAuthConfig.ts（2 行）

### 遥测 schema zcode.* 点分键与哈希输入 —— 148 行 / 5 文件
- apps/lcode-cli/packages/telemetry/src/agent-metrics.ts（18 行）
- apps/lcode-cli/packages/telemetry/src/agent-trace-runtime.ts（99 行）
- apps/lcode-cli/packages/telemetry/src/agent-trace-support.ts（10 行）
- apps/lcode-cli/packages/telemetry/src/otlp-exporter.ts（20 行）
- packages/services/src/telemetry/telemetryCore.ts（1 行）

### 生成物/第三方原文/lockfile/补丁（不手改） —— 70 行 / 4 文件
- apps/lcode-cli/pnpm-lock.yaml（19 行）
- patches/@ai-sdk__anthropic@3.0.81.patch（2 行）
- patches/@ai-sdk__openai-compatible@2.0.60.patch（2 行）
- patches/@arms__rum-electron@0.0.3.patch（47 行）

