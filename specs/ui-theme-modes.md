# 界面主题多主题（UI Theme Modes）

## 背景与目标

界面主题现状只有深色/浅色两项用户可见选择（侧栏菜单与设置页）。底层实际是「`@theme` 提供 `:root` 浅色默认 + `.dark` / `.theme-zai-light` / `.theme-zai-dark` 三个 class 覆盖块」的双机制（`packages/ui/src/styles.css:137`、`:308`、`:461`、`:606`），运行时状态唯一所有者是 Zustand store 的 `theme`/`setTheme`；但合法值集合分散在 5+ 处手写字符串白名单（`packages/ui/src/SettingsPage.tsx:1273-1291`、`packages/ui/src/WorkspaceSidebar.tsx:724-737`、`packages/ui/src/useTheme.ts:72-80` 等）与 5 处首帧引导。

本次新增 1 浅 2 深共 3 个主题，用户可见项达到 6 个。核心改动：

- 合法值与明暗基底映射收敛到 `packages/ui/src/useTheme.ts` 的单一注册表 `THEME_OPTIONS`，各白名单复用 `isThemeValue`。
- `resolveTheme` 的暗色判定从字面量 `dark||zai-dark` 改为按注册表 base 判定——这是下游全部二值折叠（原生标题栏、代码高亮选侧、webview 折叠）的唯一修复点。
- 深基底新主题用 `dark` class + `.theme-<id>` 差量变量块叠加；浅基底新主题用 `:root`/`@theme` 基底 + `.theme-<id>` 差量块叠加。5 处首帧引导必须同步挂新 class，防止首帧呈现基底色再跳变。
- 广播防回环与「跟随系统落 Zai 对」的既有语义不动。

## 主题清单

| id | 基底 | 中文名 | 英文名 | 色板要点 |
| --- | --- | --- | --- | --- |
| `system` | dynamic | 跟随系统 | System | 动态基底：由 `matchMedia(prefers-color-scheme: dark)` 实时解析，亮→`zai-light`、暗→`zai-dark`（`packages/ui/src/useTheme.ts:60-65` 现行为保持）。注册表中以 `base: "dynamic"` 与静态主题区分，消费端不得把它当静态基底读取 |
| `zai-dark` | dark | 深色主题 | Zai Dark | 既有默认深色；背景 `#161616`、前景 `#f8f8f8`、品牌反白 `#ffffff`、终端自定义 ANSI 暗系色板（`styles.css:606-750` 现值，不改） |
| `zai-light` | light | 浅色主题 | Zai Light | 既有浅色；背景 `#f8f8f8`、前景 `#0d0d0d`、品牌纯黑 `#000000`（`styles.css:461-604` 现值，不改） |
| `sepia-light` | light | 暖纸浅色 | Sepia Light | 新增浅基底：暖米纸背景（建议 ~`#f6f1e7`）、深咖前景（建议 ~`#3f382e`）、暖褐 brand、暖纸 tag/hover/selected |
| `midnight-blue` | dark | 午夜蓝 | Midnight Blue | 新增深基底：深蓝夜空背景（建议 ~`#0d1424`）、冷白前景（建议 ~`#e6ebf5`）、亮蓝 brand（建议 ~`#5b9dff`）、蓝色系终端 ANSI |
| `forest-dark` | dark | 森林深色 | Forest Dark | 新增深基底：墨绿背景（建议 ~`#101812`）、灰绿前景（建议 ~`#d9e2d9`）、苔绿 brand（建议 ~`#7fbf8e`）、绿色系终端 ANSI |

新主题三项色板为设计假设值，落地时以 `DESIGN.md`「Accessibility and Internationalization」的对比度要求实测校验后定稿。`system` 的解析兜底与默认主题一致为深色；用户可见顺序固定：system → zai-dark → zai-light → sepia-light → midnight-blue → forest-dark。

## 产品规则

1. 用户可见主题清单固定为上表 6 项且顺序固定；不得在组件内散落新的主题白名单，扩展主题只能改 `packages/ui/src/useTheme.ts` 的 `THEME_OPTIONS` 注册表。
2. 每个主题必须有唯一 kebab-case id、明暗基底、中英文显示名与三色小色板（底色/前景/主色）。深基底主题激活时 `documentElement` 同时挂 `dark` + `theme-<id>`，浅基底只挂 `theme-<id>`；`theme-<id>` 不得作为局部子树强制类——局部强制浅色继续复用完整块 `theme-zai-light`（见 `packages/ui/src/previewPaneOfficeLegacyDocContent.tsx:132` 既有用法）。
3. 首帧挂载规则：5 处启动引导（desktop `packages/desktop/src/renderer/src/main.tsx:76-100`、web `packages/web/src/main.tsx:39-67`、resource-manager `packages/desktop/src/renderer/src/resource-manager.tsx:22-47`、`packages/web/src/webThemeSeed.ts`、`packages/web/index.html:16-63` 内联脚本）必须在 React 接管前按基底挂 `dark` 并挂唯一 `theme-<id>`（含浅基底仅 `theme-<id>` 的分支）；引导写点与 `THEME_OPTIONS` 注册表必须同步放行全部 id，不允许出现「先基底色后跳变」的首帧。`web/index.html` 的 try 失败兜底分支（`:57-61`）同样只允许落到默认 `zai-dark` 组合。
4. 跟随系统语义固定为「按系统亮暗落到 Zai 深色/浅色」，不落到新增主题；快捷键/quick pick 翻转固定落在 Zai 对（`packages/ui/src/App.tsx:686-689` 经 `resolveTheme` 取明暗相反侧），不进新主题轮换。
5. 新主题必须基于明暗基底叠加差量变量，复用现有 `--color-*` 变量体系：不得新造变量名；不得直接重定义 `--color-icon-blue` 与 `--color-markdown-inline-code`（两者为全主题共享/派生色，`styles.css:162`、`:185`，后者经 `--color-tag` 跟随）；不得写不透明根背景（`styles.css:47-55` Electron vibrancy 要求透明根，新块必须给 `--color-background-win-alt` 值）。必覆盖最小集（对照 `.theme-zai-light` 实测 142 项变量清单逐项决策）：表面全家族（background/background-alt/background-win-alt/header/sidebar/panel/surface+hover/card+selected/card-border/popover 三件+header/menu+menu-hover/tab/tab-active/tab-border/toast/tooltip/tooltip-foreground/tooltip-tag+foreground/input 四件含 input-border-focused）、文本四级（foreground/subtle/subtlest/inverse）、品牌与全部 `*-foreground` 配对（brand/primary/secondary/accent/hover/selected）、`--color-tag`（实测 `styles.css:185` 是 `--color-markdown-inline-code` 的 var 源）、find-highlight 对、success/warning/destructive/idle-task(+surface)/diff-added/removed 及各自 -foreground、feedback-privacy-hint、interaction-ask-fill/foreground/surface + interaction-confirmation-foreground/surface、`--animated-gradient-text-strong/soft`、terminal 主六色（bg/fg/cursor/cursor-accent/selection/selection-inactive）不得缺项。数据色板默认继承基底、按主题色相可选主题化（继承已满足「每套主题都有定义」语义）：terminal ANSI 16 色、usage-chart-1..6、context-breakdown-1..7、usage-heatmap-0..4、六组 node tint 18 项（command/file/plugin/session/skill/subagent 的 node/node-foreground/node-hover）、git-* 8 项、trajectory 5 项、workflow-rule/trace/trace-strong、plugin-paid-plan-badge(+foreground)，但继承决策须逐项记录。
6. 所有主题下文本与交互对比度必须满足 `DESIGN.md` 无障碍要求；不得创造只在单一主题下正确的组件样式。不新增 `dark:` tailwind utility 依赖——已核实 `styles.css:15-23` 只有 platform-* custom variant、无 `@custom-variant dark`，`dark:` 前缀跟随 OS 偏好而非选中主题，新主题不做主题内差异样式。
7. 代码高亮主题（`CodePreviewSettings.lightTheme`/`darkTheme`）是独立设置维度，界面主题只决定激活亮/暗哪一侧（经 `resolveTheme`）；本次不新增代码主题，`ThemePreviewCard` 写死 Zai 四色是代码主题预览卡，不随界面主题语义变化。

## 状态所有权与数据流

- `Theme` 联合类型、解析（`resolveTheme`/`normalizeThemePreference`/`isThemeValue`/`applyTheme`）与 `THEME_OPTIONS` 注册表唯一定义在 `packages/ui/src/useTheme.ts`；`system` 的 base 以 `"dynamic"` 标注，消费端不得当静态基底读取。
- 运行时状态唯一所有者是 Zustand store 的 `theme`/`setTheme`（`packages/ui/src/store/index.ts:108-109`、`:258-265`）；`localStorage` key `"zcode-theme"` 是持久化事实；`documentElement` 的 `dark`/`theme-*` class 是投影，`applyTheme` 是主窗口唯一 DOM 写点。本地初始值（store `:257`）与广播 payload（store `:474-475`）均须经 `isThemeValue` 校验，异常值回落 `zai-dark`，不进入 store。
- 资源管理器独立窗口不建 store，其主题投影由自带引导（启动读 `localStorage` 一次）+ `storage` 事件监听（跟随主窗口 `setTheme` 写入）承担；该文件现无任何 `addEventListener`，必须新增。
- 跨窗口一致性由广播承担：`theme` 在 `BROADCAST_FIELDS`（store `:214`），发送与接收都必须经 `setTheme`；`applyingBroadcast` 防回环（store `:237`、`:438-453`、`:470-489`），不得在广播路径外直写 `localStorage` 或 setState。
- 设置页与侧栏两个入口统一消费 `THEME_OPTIONS` 注册表（`settingsPageConfig.ts` 的 `THEME_MODES` 改为由其派生并保留 lucide icon 映射；侧栏 `DropdownMenuRadioGroup` 改为 map 渲染），共用新增的三色小色板展示组件（纯展示，色值读注册表 swatch，`system` 项用对半分色表达动态），不发明新样式体系。

## 事件顺序

```text
用户选择 → 白名单校验(isThemeValue) → setTheme：normalize → localStorage
        → syncSystemThemeListener → applyTheme → set({theme})

applyTheme → resolveTheme（system/dynamic→matchMedia；深基底 id→dark）
           → toggle dark + 唯一 theme-<id> → syncBrowserThemeSurface（meta theme-color 读 --color-background）

set({theme}) → subscribe（applyingBroadcast=false）→ 广播 state:theme
             → 其他窗口 onMessage → payload isThemeValue 校验 → applyingBroadcast=true
             → setTheme（幂等）→ false

system 跟随：matchMedia change → 确认 store.theme 仍为 system → applyTheme("system") → Zai 两套

首帧：5 处引导按 localStorage + 注册表 → 按基底 toggle dark + 挂唯一 theme-<id>
     （浅基底 sepia-light 仅 theme-<id>）→ React store 接管

资源管理器：打开时读 localStorage 挂 class
           → 主窗口 setTheme 写 localStorage → storage 事件 → 重挂 theme class
```

- 两入口选择必须经 `isThemeValue` 后调用 store `setTheme`，不得绕过 `setTheme` 直接 `setState` 或直写 DOM。
- 广播接收端对 payload 校验失败时回落 `zai-dark` 且不重复广播；`applyingBroadcast` 期间 subscribe 不再发送，保证无死循环。
- 快捷键翻转（`App.tsx:686-689`）经 `resolveTheme` 取反后走同一 `setTheme` 链路，无独立写路径。

## 兼容性要求

- `localStorage` 旧值 `light`/`dark`/`zai-light`/`zai-dark`/`system` 全部继续有效：`normalizeThemePreference` 不变（`dark`→`zai-dark`、`light`→`zai-light`，新 id 原样透传）；默认 `zai-dark` 四处不变（store `:257`、useTheme `:86`、`packages/web/index.html` `DEFAULT_THEME`、`packages/web/src/webThemeSeed.ts` `WEB_DEFAULT_THEME`）。异常本地值与异常广播值一律回落 `zai-dark`，不改广播机制本身。
- 折叠边界保持：Electron 原生标题栏收 `light`/`dark`/`system`（`packages/ui/src/root/useDesktopNativeThemeSync.ts:23` 直接透传 `resolveTheme` 结果）；CodingPlan webview 折叠到 Zai 两值（`packages/ui/src/settings/CodingPlanEmbeddedWebviewDialog.tsx:118-121`）；office docx 预览固定 `theme-zai-light`；分享页默认 `zai-light`（`packages/web/src/share/ConversationShareLandingPage.tsx:275`、`:710`）；web 浏览器首帧 meta theme-color 二值种子被 React 接管后按真实变量值覆盖。
- 字面量主题判定收敛为共享归类：`resolveTheme` 暗色判定扩为按注册表 base 后，`packages/ui/src/components/ai-elements/message.tsx:853-854`、`packages/ui/src/ToolCallBlocks/renderers/EditInlineDiffContent.tsx:33`、`packages/ui/src/components/ai-elements/mermaid-block.tsx:193-195`（SSR 分支）三处 `dark||zai-dark` 字面量必改，避免新深基底下代码高亮/mermaid 选错亮侧。
- 明确不改（防验收误判）：快捷键翻转落 Zai 对；`ThemePreviewCard` 写死 Zai 四色（代码主题预览，`packages/ui/src/settings/SettingsPageParts.tsx:47-63`）；`packages/desktop/src/main/forceUpdatePrompt.ts:524` 强更弹窗背景按 `nativeTheme` 二值（`#2b2b2b`/`#f8f8f8`）跟随系统而非界面主题；`.theme-zai-light`/`.theme-zai-dark` 类名保持不变；`packages/ui/src/app-shell/workflow-artifacts/presets/palette.ts:4-6` 注释口径同步更新（新主题经差量继承基底满足「每套主题都有定义」）。
- 资源管理器窗口新增 `storage` 事件监听：不补则独立窗口持续停留旧主题，无法满足「与主窗口主题一致」验收。

## i18n 要求

所有主题显示名走 i18n，无硬编码文案；两语言 key 集合保持对齐。

- 新增（zh / en）：`settings.themeMode.sepia-light`（暖纸浅色 / Sepia Light）、`settings.themeMode.midnight-blue`（午夜蓝 / Midnight Blue）、`settings.themeMode.forest-dark`（森林深色 / Forest Dark）；`sidebar.settings.theme.` 下同三个 id 同文案。
- 修改：`settings.themeModeDescription` 改为「选择界面主题或跟随系统主题。」/ "Choose an app theme or follow the system theme."（原文案只提及浅色/深色，已不覆盖新主题）。
- 删除死文案：`THEME_MODES` 收敛后 `settings.themeMode.light`/`dark`（zh-CN `:1630-1631`、en-US `:1729-1730`）与 `sidebar.settings.theme.light`/`dark`（zh-CN `:1857`、`:1860`、en-US `:1968`、`:1971`）成为无消费者 key，按 knip 惯例删除。
- 保留：`settings.themeMode.zai-light`/`zai-dark`/`system`、`sidebar.settings.theme.zai-light`/`zai-dark`、`sidebar.settings.systemDefault`（system 项沿用）。

## 验收场景

- 设置页与侧栏菜单可见 6 项，中英文文案齐全、无裸 id 展示；选择每一项后 `documentElement` class 组合正确（深基底 = `dark` + `theme-<id>`，浅基底 = 仅 `theme-<id>`）。
- 首帧：`localStorage` 预置新 id 后冷启动，React 接管前即呈现新主题差量色（而非 `.dark` neutral / `:root` neutral 基底色），无基底→主题跳变；desktop 与 web（含 `web/index.html` 内联引导的 class 与 `data-zcode-bootstrap-theme`/meta theme-color）均验证。
- 旧值兼容：`localStorage` 预置 `"dark"`/`"light"` 刷新后归一 Zai 对；预置异常字符串经本地初始值与广播 payload 两条路径均回落 `zai-dark`，不进入 store、不触发广播。
- 跟随系统：`system` 下切换 OS 亮暗实时落到 Zai 对；新主题不参与跟随系统；选中主题与系统偏好相反的组合下无大块错色（`dark:` utility 已知跟随 OS，不计为回归）。
- 广播同步不回环：双窗口 A 切换新 id，B 经广播同步且无死循环（`applyingBroadcast` 防回环不二次广播），两窗口 DOM class 一致。
- 资源管理器窗口：打开时与主窗口主题一致；主窗口切换主题后经 `storage` 事件实时同步一致。
- 代码高亮主题不受影响：6 项逐一验证终端配色、mermaid、图表数据色板正确跟随；深基底新主题下代码高亮取 `darkTheme`、浅基底取 `lightTheme`；`CodePreviewSettings` 的亮/暗代码主题选择与界面主题互不干扰。
- 折叠边界：Electron 原生标题栏明暗与新主题基底一致；web 浏览器地址栏 theme-color 随新主题更新；强更弹窗背景仍按系统明暗二值（明确不改项，不得误判为回归）；快捷键在新主题下切到明暗相反的 Zai 对。
- i18n 对齐检查：两语言无死文案 key、无裸 id 展示。
- 实现阶段必须真实执行 `pnpm typecheck` 与 `pnpm lint`（`package.json:30`、`:38` 已确认存在）并报告真实结果；`pnpm architecture:check --changed` 无新增违规。
