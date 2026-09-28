# LCode 品牌迁移决策与执行记录（ZCode → LCode）

> 依据 `out/lcode-brand-survey.md`（2026-09-28 品牌检索报告）执行全仓更名。本文件是第 0 步的决策输出与批次 1–5 的执行/验收记录，迁移完成后长期保留作为例外清单与兼容边界的权威来源。

## 第 0 步决策（2026-09-28，执行者按报告默认选项确认）

| 决策项 | 选择 | 依据 |
| --- | --- | --- |
| 与上游 zai-org/ZCode 的同步策略 | **硬 fork**：不再合并上游，仅人工 cherry-pick 安全修复 | 全量改名后 merge 必然大面积冲突；L-GO 已规划 Go 重构方向 |
| 数据迁移执行方式 | **首次启动自动触发**（Desktop main / CLI 早期初始化各接一次），复制式：临时目录复制 → 校验 → 原子切换 → **保留源目录** | 报告注意事项第 1 节约束：幂等、失败清理临时目录、严禁删改源目录 |
| 产品身份切换形态 | **并列安装**：新 appId `dev.lcode.app`、productName `LCode`，与旧 ZCode 应用并存；数据复制式迁移后各自演进 | 报告对照表批次 4 + 第 2 步默认 |
| 旧版本互连支持矩阵 | **全量切换，不做双读**（握手/流控/marker/通道一次切新）：新 Desktop/CLI/server 互通；与一切旧端断连，靠现有部署链路重推新 bundle；在发布说明标注强制同步升级 | 报告矩阵选项 B；「第 3 步顺手加握手失败版本化错误提示」列为后续可选项，本次不做 |
| 「其余 packages」6 目录缺口 | 已完成定向补扫（40 个 `ZCODE_*` 名、`zcode.cua/*` meta 键、`zcode_cua_frame_ref` 帧类型均为仓内双侧契约，随批次 1 机械替换；无含 zcode 的 URL） | 报告「计数口径差异说明」要求并入第 0 步 |

## 保留清单（批次 0——永不机械替换）

以下值是外部契约或兼容读取边界，出现即保留，全部登记进例外清单：

1. **域名族**：`zcode.z.ai`（含 `cdn-zcode.z.ai`、`dev@zcode.z.ai`、URL 内 `/zcode/` 路径段）、API 网关路径 `zcode-plan`。
2. **身份提供方**：OAuth appId 字面量 `"zcode"`（bigmodel-oauth.ts、webZaiOAuthConfig.ts）、API key 名 `zcode-api-key`。
3. **MCP 命名空间**：`com.zcode/*`（含 Go 侧产出）。
4. **插件市场**：市场 ID 与插件 ID 后缀 `zcode-plugins-official`。
5. **外部包名**：`zcode_cua`（PyPI）、`zcode-cua.server`（npm）。
6. **官网跨站契约**：`zcodeBridge`、`__zcodeLang__`、`zcode-coding-plan-lang-change`、注入官网页的 `localStorage "zcode-theme"` 与 `"zcode:coding-plan:embedded"`（codingPlanWebview.ts / codingPlanEmbeddedWebview.ts 内）。
7. **持久化枚举/数据标识**：枚举字面量 `"zcode"`（CustomCommandSource、SkillSource、McpSyncSource、SettingsDirectorySource、settings-sync、skill source、telemetry skillSource）、`"zcodeagentmcp"`（MCP source 值，CLI 配置文件双侧一致）、旧 config.json 字段 `provider.zcode`/`model.zcode`、迁移源键 `localStorage:zcode-mcp-config`、SQLite 行键 `__zcode_internal_*` 与 traceId 前缀 `zcode-${task_id}`。
8. **遥测 schema**：OTel 前缀 `zcode.agent.*`/`zcode.agent_turn.*`/`zcode.tool_execution.*` 等（telemetry 包内全部点分键）与哈希输入 `zcode:session_create:v1`。
9. **上游指认**：README/NOTICE 对 `zai-org/ZCode` 的引用与锚点、第三方许可证原文（THIRD-PARTY-NOTICES.md、third-party/inventory.json——不机械改，重跑生成器再生）。
10. **第三方 patch 内部标识**：patches/@arms__rum-electron 的 `zcodeConsole*`（patch 内容不改，hash 保持有效）。

## 兼容读取清单（新值生效 + 旧值兼容，批次 2）

| 类别 | 新值 | 旧值兼容方式 |
| --- | --- | --- |
| 用户数据根 | `~/.lcode`（cli/、v2/） | 首启自动复制迁移，源目录保留 |
| 工作区目录 | `<workspace>/.lcode`、`.lcode-plugin` | 首次访问时复制迁移 |
| Electron userData | `appData/LCode` | main 早期把旧 `appData/ZCode` 复制迁移 |
| Chromium 分区 | `persist:lcode-embedded-browser`、`persist:lcode-coding-plan` | 分区目录复制迁移 |
| localStorage 键 | `lcode-theme`、`lcode-locale`、`lcode:remote-pairing:*` | 读新键，缺失时读旧键并回写 |
| 凭据键 | `lcodejwttoken` | 读新键，缺失时读旧键 `zcodejwttoken` |
| Web 鉴权 cookie | `lcode_lite_token` | 服务端双读旧 cookie `zcode_lite_token`（过渡期） |
| 用户/宿主可设 env | `LCODE_HOME`、`LCODE_DATA_BASE_DIR`、`LCODE_AGENT_SERVER_COMMAND/ARGS_JSON/CWD` | 读新名，缺失时读旧名 `ZCODE_*` |
| 插件子进程 env | `${LCODE_PLUGIN_ROOT}` 等 | 注入双侧（LCODE_* + ZCODE_*），展开正则同时认 LCODE_/ZCODE_/CLAUDE_ |
| URL scheme | `lcode://` 主注册 | 解析器同时接受旧 `zcode://`，protocols.schemes 双注册 |
| hook 配置文件 | `.lcode/config.json`、`lcode.json` | 探测新名，缺失时探测旧名 |

## 执行批次与勾选

- [ ] 批次 1：目录/文件改名 + 内容机械替换（ZCode→LCode、zcode→lcode、ZCODE→LCODE、Zcode→Lcode 四变体）+ pnpm install 重生成 lockfile + 第三方清单/feature-graph 重生成 + typecheck/lint 兜底。**严禁碰**：bizCode（zCode）6 行、existingLcode 100 行无关子串、保留清单全部。
- [ ] 批次 2：数据与凭据迁移代码 + 兼容读取 + installer.nsh 旧数据目录双检测 + 迁移测试。
- [ ] 批次 3：协议 wire 值三端同批（随批次 1 机械替换完成，本批核验配对完整性）。
- [ ] 批次 4：打包身份/OS 集成核验（产物命名测试、CI env、scheme 注册）。
- [ ] 批次 5：文档文案复核（i18n 组合词、README 上游引用保留、.agents 技能头、清理 .zcode 旧草稿）。

## 验收标准

1. 除本文件保留清单/例外清单外，`git grep -I -i zcode` 全仓输出为空（例外清单见下节，逐条带路径与原因）。
2. `pnpm typecheck`、`pnpm lint` 通过；`node --test scripts/github-release.test.mjs` 等定向测试通过。
3. 架构检查 `pnpm architecture:check --changed` 通过（基线模块 id 已同步改名）。

## 例外清单（批次 1 后实测登记）

## 例外清单（`git grep -I -i zcode` 全仓残余，自动分类于迁移执行时）

### 品牌迁移兼容读取点（批次2/3：env 旧名回退、存储/凭据旧键双读、旧数据目录探测、迁移模块自身） —— 128 行 / 46 文件
- .gitignore（1 行）
- apps/lcode-cli/packages/adapters/src/auth/shared-credentials.ts（2 行）
- apps/lcode-cli/packages/adapters/src/device/cli-device-mid.ts（2 行）
- apps/lcode-cli/packages/adapters/src/mcp/index.ts（1 行）
- apps/lcode-cli/packages/adapters/src/mcp/official-auth.ts（1 行）
- apps/lcode-cli/packages/bootstrap/src/app/built-in-node-repl.ts（2 行）
- apps/lcode-cli/packages/bootstrap/src/custom-command-shell-expansion.ts（9 行）
- apps/lcode-cli/packages/cli/src/main.ts（2 行）
- apps/lcode-cli/packages/contracts/src/interfaces/mcp.port.ts（3 行）
- apps/lcode-cli/packages/node-repl-host/src/server.ts（1 行）
- apps/lcode-cli/packages/telemetry/src/bootstrap.ts（2 行）
- packages/desktop/build/installer.nsh（7 行）
- packages/desktop/electron-builder.config.js（1 行）
- packages/desktop/src/main/desktopDataBaseDirBootstrap.ts（4 行）
- packages/desktop/src/main/desktopDeepLinkUrl.ts（2 行）
- packages/desktop/src/main/desktopEarlyDataBaseDirBootstrap.ts（1 行）
- packages/desktop/src/main/desktopRuntimeEnv.ts（2 行）
- packages/desktop/src/main/desktopWindowChrome.ts（2 行）
- packages/desktop/src/preload/codingPlanWebview.ts（4 行）
- packages/desktop/src/renderer/src/main.tsx（2 行）
- packages/lcode-cua/broker-server.js（3 行）
- packages/lcode-cua/broker.test.js（2 行）
- packages/lcode-cua/e2e-packaged-node-repl.mjs（1 行）
- packages/server/src/entry-http.ts（1 行）
- packages/server/src/entry-stdio.ts（1 行）
- packages/server/src/http.ts（1 行）
- packages/services/src/hooks/hooksService.ts（1 行）
- packages/services/src/lcode-agent/lcodeAgentProcessManager.ts（4 行）
- packages/services/src/model-provider/accountProviderCredentialStore.ts（1 行）
- packages/services/src/model-provider/legacyLCodeConfigProviderReader.ts（7 行）
- packages/services/src/model-provider/providerProvisioningTarget.ts（1 行）
- packages/services/src/paths.ts（2 行）
- packages/shared/src/channels.ts（2 行）
- packages/shared/src/node/brandDataMigration.ts（8 行）
- packages/shared/src/official-mcp-auth.ts（2 行）
- packages/shared/src/workspace-hook-config.ts（6 行）
- packages/ui/src/ToolCallBlocks/renderers/agentHelpers.ts（2 行）
- packages/ui/src/lib/toolIdentity.ts（2 行）
- packages/ui/src/settings/CodingPlanEmbeddedWebviewDialog.tsx（2 行）
- packages/ui/src/settings/CodingPlanUpgradeDialog.tsx（1 行）
- packages/ui/src/settings/model-provider-section/codingPlanEmbeddedWebview.ts（3 行）
- packages/ui/src/store/index.ts（2 行）
- packages/web/index.html（2 行）
- packages/web/src/remote/mirrorReconnect.ts（2 行）
- packages/web/src/remote/pairingCredentialStore.ts（2 行）
- scripts/lcode-brand-migration.test.mjs（16 行）

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

### 官网跨站契约 zcodeBridge / __zcodeLang__ / zcode-coding-plan-lang-change / zcode:coding-plan:embedded / 注入页 zcode-theme —— 12 行 / 4 文件
- packages/desktop/src/main/desktopWindowChrome.ts（1 行）
- packages/desktop/src/preload/codingPlanWebview.ts（4 行）
- packages/shared/src/channels.ts（1 行）
- packages/ui/src/settings/model-provider-section/codingPlanEmbeddedWebview.ts（6 行）

### 持久化枚举/数据标识 "zcode" / zcodeagentmcp / provider.zcode / model.zcode / localStorage:zcode-mcp-config / __zcode_internal —— 88 行 / 37 文件
- apps/lcode-cli/packages/adapters/src/auth/bigmodel-oauth.ts（1 行）
- apps/lcode-cli/packages/adapters/src/commands/roots.ts（2 行）
- apps/lcode-cli/packages/adapters/src/skills/roots.ts（2 行）
- apps/lcode-cli/packages/contracts/src/commands/index.ts（1 行）
- apps/lcode-cli/packages/contracts/src/skills/index.ts（1 行）
- packages/desktop/electron-builder.config.js（1 行）
- packages/desktop/src/main/mcpUserDirectory/index.ts（3 行）
- packages/desktop/src/main/mcpUserDirectory/types.ts（1 行）
- packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts（1 行）
- packages/services/src/commands/commandsService.ts（2 行）
- packages/services/src/hooks/hooksService.ts（7 行）
- packages/services/src/hooks/workspaceHookSettingsModel.ts（1 行）
- packages/services/src/mcp-sync/mcpSyncService.ts（4 行）
- packages/services/src/model-provider/legacyLCodeConfigProviderReader.ts（1 行）
- packages/services/src/oauth/providers/bigmodelProviderConfig.ts（1 行）
- packages/shared/src/lcode-protocol-v4/telemetry.ts（1 行）
- packages/shared/src/lcode-task-types-core.ts（2 行）
- packages/shared/src/mcp-sync.ts（1 行）
- packages/shared/src/mcp.ts（2 行）
- packages/shared/src/settings-source.ts（1 行）
- packages/shared/src/settings-sync.ts（1 行）
- packages/ui/src/lib/lcodeUiError.ts（11 行）
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

### ⚠ 未分类（需人工处理）—— 3 行
- apps/lcode-cli/packages/bootstrap/src/custom-command-shell-expansion.ts（1 行）
- packages/desktop/src/main/desktopDeepLinkUrl.ts（1 行）
- packages/server/src/http.ts（1 行）

（例外清单由 `.zcode/gen-exceptions.mjs` 按保留类别自动生成；品牌验收 grep 以本清单为排除集，未分类为 0 即全部残余均有登记原因。）
