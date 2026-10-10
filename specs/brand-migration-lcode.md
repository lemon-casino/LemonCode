# LCode 品牌迁移决策与执行记录（ZCode → LCode）

> 依据 `out/lcode-brand-survey.md`（2026-09-28 品牌检索报告）执行全仓更名。本文件是第 0 步的决策输出与批次 1–5 的执行/验收记录，迁移完成后长期保留作为例外清单与兼容边界的权威来源。

## 第 0 步决策（2026-09-28，执行者按报告默认选项确认）

| 决策项                          | 选择                                                                                                                                                         | 依据                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| 与上游 zai-org/ZCode 的同步策略 | **硬 fork**：不再合并上游，仅人工 cherry-pick 安全修复                                                                                                       | 全量改名后 merge 必然大面积冲突；L-GO 已规划 Go 重构方向                        |
| 数据迁移执行方式                | **首次启动自动触发**（Desktop main / CLI 早期初始化各接一次），复制式：临时目录复制 → 校验 → 原子切换 → **保留源目录**                                       | 报告注意事项第 1 节约束：幂等、失败清理临时目录、严禁删改源目录                 |
| 产品身份切换形态                | **并列安装**：新 appId `dev.lcode.app`、productName `LCode`，与旧 ZCode 应用并存；数据复制式迁移后各自演进                                                   | 报告对照表批次 4 + 第 2 步默认                                                  |
| 旧版本互连支持矩阵              | **全量切换，不做双读**（握手/流控/marker/通道一次切新）：新 Desktop/CLI/server 互通；与一切旧端断连，靠现有部署链路重推新 bundle；在发布说明标注强制同步升级 | 报告矩阵选项 B；「第 3 步顺手加握手失败版本化错误提示」列为后续可选项，本次不做 |
| 「其余 packages」6 目录缺口     | 已完成定向补扫（40 个 `ZCODE_*` 名、`zcode.cua/*` meta 键、`zcode_cua_frame_ref` 帧类型均为仓内双侧契约，随批次 1 机械替换；无含 zcode 的 URL）              | 报告「计数口径差异说明」要求并入第 0 步                                         |

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
10. **第三方 patch 内部标识**：patches/@arms\_\_rum-electron 的 `zcodeConsole*`（patch 内容不改，hash 保持有效）。

## 兼容读取清单（新值生效 + 旧值兼容，批次 2）

| 类别              | 新值                                                                            | 旧值兼容方式                                                           |
| ----------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 用户数据根        | `~/.lcode`（cli/、v2/）                                                         | 首启自动复制迁移，源目录保留                                           |
| 工作区目录        | `<workspace>/.lcode`、`.lcode-plugin`                                           | 首次访问时复制迁移                                                     |
| Electron userData | `appData/LCode`                                                                 | main 早期把旧 `appData/ZCode` 复制迁移                                 |
| Chromium 分区     | `persist:lcode-embedded-browser`、`persist:lcode-coding-plan`                   | 分区目录复制迁移                                                       |
| localStorage 键   | `lcode-theme`、`lcode-locale`、`lcode:remote-pairing:*`                         | 读新键，缺失时读旧键并回写                                             |
| 凭据键            | `lcodejwttoken`                                                                 | 读新键，缺失时读旧键 `zcodejwttoken`                                   |
| Web 鉴权 cookie   | `lcode_lite_token`                                                              | 服务端双读旧 cookie `zcode_lite_token`（过渡期）                       |
| 用户/宿主可设 env | `LCODE_HOME`、`LCODE_DATA_BASE_DIR`、`LCODE_AGENT_SERVER_COMMAND/ARGS_JSON/CWD` | 读新名，缺失时读旧名 `ZCODE_*`                                         |
| 插件子进程 env    | `${LCODE_PLUGIN_ROOT}` 等                                                       | 注入双侧（LCODE*\* + ZCODE*\*），展开正则同时认 LCODE*/ZCODE*/CLAUDE\_ |
| URL scheme        | `lcode://` 主注册                                                               | 解析器同时接受旧 `zcode://`，protocols.schemes 双注册                  |
| hook 配置文件     | `.lcode/config.json`、`lcode.json`                                              | 探测新名，缺失时探测旧名                                               |

### 全平台并列安装身份边界（2026-09-29）

- **产品身份所有者**：Electron Builder 的 `desktop-product-identity.mjs` 唯一持有 LCode 的 `appId`、产品名、Linux 包名和可执行文件名；平台打包配置只消费该身份，不维护第二套可变品牌映射。保留的 ZCode 身份是禁止碰撞的迁移边界，不参与 LCode 运行时选择。
- **Windows 边界**：ZCode 与 LCode 的 appId、APP_GUID/卸载注册表键、默认安装目录、快捷方式、可执行文件名和安装器互斥锁必须彼此独立。安装或升级某一产品时，只能检测并关闭该产品的 `${APP_EXECUTABLE_FILENAME}`，不得按共同父目录做 `StartsWith($INSTDIR)` 扫描；真实同产品升级仍须等待自身进程退出。
- **macOS 边界**：正式包固定为 `LCode.app`、`CFBundleIdentifier=dev.lcode.app`，与 `ZCode.app`、`dev.zcode.app` 分离；DMG 拖拽安装只能覆盖同名 `.app`，不得要求退出或替换另一品牌。应用名同时隔离 Electron `userData` 与单实例锁。
- **Linux 边界**：正式包固定使用 `lcode` 可执行文件和 `lcode` 的 deb/rpm/pacman 包名，与旧 `zcode` 完全分离；AppImage 文件名、原生包 metadata 和 unpacked 可执行文件必须一致，包管理器不得把另一品牌识别为升级目标。
- **正式构建与 GitHub Actions**：本地 `pnpm bundle:desktop` 在打包后必须检查实际产物身份；`.github/workflows/desktop-release.yml` 的 macOS、Windows、Linux × x64/arm64 六个正式构建都经由同一门禁，任一平台仍出现 ZCode 身份或包名即禁止 staging、上传与发布。
- **测试后端产物校验**：`LCODE_ENV` 非 production 的本地包使用 Preview 身份及 `_TEST` 安装包后缀；打包后身份校验必须按同一环境后缀定位真实产物，继续检查可执行文件与安装包的原生 ProductName，不得因文件名不匹配误报缺包或跳过校验。正式包不带该后缀。
- **兼容边界**：修复进入新生成的安装器；已经发布的旧 ZCode `.exe` 不可由 LCode 运行时反向改写，需要在 ZCode 维护分支回移同一 NSIS 规则并重新出包。LCode 不通过改名、共享注册表或运行时规避来迁就旧安装器。`zcode://` 仅作为旧深链兼容注册，操作系统可能由最后注册者成为默认 handler，但它不代表安装、进程或数据身份共享。
- **验收场景**：① ZCode 运行时安装/升级 LCode，ZCode 继续运行；② LCode 运行时使用回移修复后的 ZCode 安装器，LCode 继续运行；③ 同产品升级仍只处理自身进程；④ macOS 两个 `.app` 可并列且 Bundle ID 不同；⑤ Linux 的 AppImage、deb、rpm、pacman 与 unpacked 可执行文件均使用 `lcode` 身份；⑥ Actions 六平台矩阵在 staging 前完成实际产物身份校验；⑦ Windows NSIS 与各平台正式包均实际编译通过。

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

## 打包验证（2026-09-28 补充）

- `pnpm bundle:desktop -- --os win --arch x64` 出包成功：`packages/desktop/dist-lcode-fresh/LCode Preview-3.14.9-win-x64_TEST.exe`（143.5 MiB，本机非发布环境走 Preview/TEST 形态；正式命名 LCode-<version>-\* 由 release CI 产出，命名断言测试 7/7 已覆盖）
- 包内 `resources/glm/lcode.cjs` 就位（Host 启动 Agent 的入口）；NSIS 编译通过——installer.nsh 旧 .zcode 数据目录阻断语法有效
- 过程中发现并处理：node_modules 里 app-builder-lib 的 NSIS 模板留着 v3.14.8 构建打入的旧补丁（标记 zcode-installer-details-v1），与改名后的 PATCH_MARKER 不互认——已还原为上游形态，本次构建由新脚本重新打补丁；CI 干净环境不受影响
- 旧 dist/win-unpacked/resources/app.asar 被无关进程（杀毒/索引类；运行中的 D:\ZCode\ZCode.exe 均为已安装旧版应用，与 repo 无关，未触碰）占用无法清理——用 LCODE_DESKTOP_DIST_DIR=dist-lcode-fresh 换输出目录绕过
- **迁移逻辑真实环境实测**：打包过程触发工作区复制式迁移——.lcode/ 快照副本生成、.zcode/ 源目录完整保留、草稿一致；.lcode/ 已入 gitignore（429bfbb）
- **正式版构建（2026-09-28）**：按 CI desktop-release.yml 同配方（`LCODE_ENV=production LCODE_SKIP_REMOTE_ASSETS=1 LCODE_TARGET_OS/ARCH CSC_IDENTITY_AUTO_DISCOVERY=false LCODE_ENABLE_MAC_SIGN=0`）出包 `LCode-3.14.9-win-x64.exe`（143.5 MiB）——产物名符合发布规范模板（无 \_TEST 后缀）、win-unpacked 可执行名为 `LCode.exe`（productName=LCode 正式身份，非 Preview）、updater latest.yml 指向正式命名；`resources/glm/lcode.cjs` 就位
- **应用图标替换（2026-09-29）**：全套替换为用户提供的 LCode 柠檬 L 图标——build/ 的 icon.ico/icns/png、icon_installer.\*、icon_windows.png、icons/ 九档；public/logo/icons/ 九档+ico/icns；public/icon_512@2x.png；web/favicon.ico 与 index.html 内嵌 32x32 base64；cfworker-remote favicon（独立仓 `e6f8da4`）。ICO 用用户提供件（16-256 九档）；PNG 从 master 1024 System.Drawing 高质量缩放；ICNS 手写容器（ic07/08/09/10 嵌 PNG，注意 BE 长度字段勿双反转）；TUI 启动 ASCII 艺术字 ZCode→LCode。引用面全为同名文件，零引用代码改动。产物验证：重出包内 tray_icon.ico/icon.png hash 与新图标一致。**v5 更换（2026-09-29）**：应用图标整体更换为 rounded-v5 圆角彩色版（黄 L + 柠檬花圆徽 + 绿 L，提交 b547ebe/5e84ee2），同流水线重出包并验证产物 hash 一致。**未动**：dmg_background（macOS 背景图含旧品牌视觉，无法程序化替换，留给设计）；provider-icons/logo-zai（第三方供应商标识）；material-icons（通用图标字体）。
- **V12 透明主题图标收口（2026-09-29）**：V12 定稿固定为透明背景、上方科技蓝、左下活力绿、右下柠檬黄；`packages/ui/src/assets/app-logo.svg` 是软件内品牌图形的唯一事实源，组件只负责尺寸、透明度和主题遮罩，不得再内嵌另一套字母路径或引用旧 `assets/Z.svg`。承载品牌徽标的 UI 容器也必须保持透明，不得继承头像组件的固定浅色圆底、边框或混合模式；真实用户头像仍沿用现有主题化头像样式。安装包 `build/` 的 ICO/ICNS/PNG、Web favicon/内嵌启动图、主仓 `public/logo/icons/` 与独立仓 `cfworker-remote/public/` 均由同一 V12 母版导出；供应商 `provider-icons/logo-zai*` 与通用 material-icons 不属于应用品牌，不随本次替换。macOS DMG 的 1x/2x 背景必须把 `ZCODE` 旧字标改为 `LCODE`，拖拽区左侧应用图标继续由同一 V12 ICNS 提供，不能因应用图标已正确而漏掉安装背景。状态所有者：本变更不新增运行时状态，品牌资产由上述 SVG/导出物持有，`ConversationDraftEmptyState` 仅渲染。验收场景：① 桌面与 Web 的新会话空状态在全部浅/深主题显示同一 V12 图标且问候文案仍清晰（大尺寸图标在普通文档流中向下渐隐，标题独立放大且不受遮罩影响，见 ui-theme-modes.md）；② 无账号侧栏品牌头像在浅色、深色及自定义主题下均透出当前背景，不出现白色/固定色圆片，登录用户头像不受影响；③ 全仓不再引用 `assets/Z.svg`，旧 Z 空状态路径不存在；④ Windows/macOS/Linux 打包配置引用 V12 导出物，DMG 不出现 `ZCODE`；⑤ `cfworker-remote` favicon、32px 内嵌 favicon 与 256px 启动图和主仓 V12 一致；⑥ Windows x64 安装包实际出包后，解包内应用图标与本次 V12 源哈希/像素来源一致。
- **⚠ cfworker-remote 盲区（2026-09-28 发现并修复）**：`cfworker-remote/` 是独立 git 仓（主仓 .gitignore:74），完全逃过批次 1 的 codemod（只处理主仓跟踪文件）。其中存在**真实断链**：Worker 校验 `x-zcode-remote-access-key`，而主仓桌面已改发 `x-lcode-remote-access-key`——不修则新桌面连 Worker 必 401，手机远控全断。已在独立仓修复并提交（`7dd8e24`+`13498f2`，**未推送**）：header 双读（lcode 主读 + zcode 旧读，常量时间比较保留，两代桌面共存、无部署协调窗口）、源码/文档品牌替换、`public/` 资产同步主仓 web 新构建（937 文件换血，assets 里的残余 zcode 均为主仓保留清单项——旧键双读/域名/持久化枚举，符合设计）。验证：worker `npm run typecheck` 0 错误、`npm test` 13/13。**部署注意**：该仓 push 即 Workers Builds 自动部署——部署后新旧桌面均兼容（双读）；但新 LCode 桌面 + 旧已部署 Worker 会 401，故部署新 Worker 前不要分发新桌面给别人用于远控。教训：迁移验收 grep 必须覆盖 gitignore 的嵌套独立仓。
- **⚠ 安装启动崩溃事故与修复（2026-09-28）**：首个正式包启动即崩 `migrateDesktopIdentityDataSync is not defined`——批次 2 接线在 `src/main/index.ts` 加了调用但**漏加 import**。根因：desktop 主进程/preload 有独立 tsconfig（tsconfig.main/preload.json）但**不在根 typecheck 门禁**（root typecheck 只引 tsconfig.host.json=src/host），esbuild 打包也不校验未定义标识符，缺陷漏网到安装包。修复：补 import（e7d521f 之后）；甄别确认 preload 的 TS2305（DesktopZoomState 等）与 main 的 DOM TS2304 均为既有类型债（基线即如此，这些 tsconfig 平时不参与门禁），迁移引入的未定义引用仅此一处。产物验证：本地 out/main/index.js 中定义+调用成对（esbuild 内联函数命名标记确认）；重出包 `LCode-3.14.9-win-x64.exe`。**预防建议**：将 tsconfig.main/preload 纳入类型门禁需先清偿既有类型债，暂以「主进程接线改动必须跑 `npx tsc --noEmit -p tsconfig.main.json` 并过滤 TS2304/TS2305」作为人工门禁。

## 例外清单（批次 1 后实测登记）

## 例外清单（`git grep -I -i zcode` 全仓残余，自动分类于迁移执行时）

### 品牌迁移兼容读取点（批次2/3：env 旧名回退、存储/凭据旧键双读、旧数据目录探测、迁移模块自身） —— 129 行 / 46 文件

- .gitignore（1 行）
- apps/lcode-cli/packages/adapters/src/auth/shared-credentials.ts（2 行）
- apps/lcode-cli/packages/adapters/src/device/cli-device-mid.ts（2 行）
- apps/lcode-cli/packages/adapters/src/mcp/index.ts（1 行）
- apps/lcode-cli/packages/adapters/src/mcp/official-auth.ts（1 行）
- apps/lcode-cli/packages/bootstrap/src/app/built-in-node-repl.ts（2 行）
- apps/lcode-cli/packages/bootstrap/src/custom-command-shell-expansion.ts（10 行）
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

### DEEP*LINK_RE 旧 scheme 双认正则 / 展开正则 ZCODE* 族 / cookie 旧名常量 —— 2 行 / 2 文件

- packages/desktop/src/main/desktopDeepLinkUrl.ts（1 行）
- packages/server/src/http.ts（1 行）

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

### 官网跨站契约 zcodeBridge / **zcodeLang** / zcode-coding-plan-lang-change / zcode:coding-plan:embedded / 注入页 zcode-theme —— 12 行 / 4 文件

- packages/desktop/src/main/desktopWindowChrome.ts（1 行）
- packages/desktop/src/preload/codingPlanWebview.ts（4 行）
- packages/shared/src/channels.ts（1 行）
- packages/ui/src/settings/model-provider-section/codingPlanEmbeddedWebview.ts（6 行）

### 持久化枚举/数据标识 "zcode" / zcodeagentmcp / provider.zcode / model.zcode / localStorage:zcode-mcp-config / \_\_zcode_internal —— 88 行 / 37 文件

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

### 遥测 schema zcode.\* 点分键与哈希输入 —— 148 行 / 5 文件

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

（例外清单由 `.zcode/gen-exceptions.mjs` 按保留类别自动生成；品牌验收 grep 以本清单为排除集，未分类为 0 即全部残余均有登记原因。）- **⚠ 应用内 Z 徽标（2026-09-29，用户实装发现）**：二进制图标之外还有一批 **SVG 组件/内嵌图形**形式的品牌标，二进制替换覆盖不到——`LCodeAboutLogo` 组件（批次 1 只改了组件名，里面的 Z path 没改）、`LCodeWordmarkLogo` 字标的 Z 字形、三处把 `provider-icons/logo-zai.svg`（智谱供应商图标）误当应用 logo（App 顶部/折叠侧栏/Windows 左上角）、四处内嵌首屏/About Z 徽标（desktop renderer index.html、RootStartupLoading.tsx、aboutWindow.ts、web index.html，含呼吸/错峰动画）。已全部替换为 lemon-l-rounded-icon-v5 图形（新增 `assets/app-logo.svg`；`logo-zai.svg` 保留给 oauthProviderIcon/供应商列表的第三方语义）。产物验证：asar 解包 grep——`lcode-hub-clip` 新图形进 styles chunk，旧 Z path `M134.4 0.130152` 全仓与产物 0 残留。教训：**品牌图形残留要按「内嵌 SVG path 特征串」专门 grep**（如 `M134.4 0.130152`），二进制 hash 替换 + 文本 grep 都覆盖不到这类。
