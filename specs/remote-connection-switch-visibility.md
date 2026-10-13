# SSH 认证与下载方式切换的主题可见性

## 产品规则

用户截图中认证方式和资源下载方式的选中背景使用 background，几乎与 input 容器相同，
其他主题也难以分辨。两个控件应统一使用现有主题 selected、foreground、brand 和 focus token。

- 已选项有 selected 背景及可见强调边框，未选项使用次级文字；hover 与键盘 focus 不覆盖已选填色。
- 按钮保留原选择值、默认值和原 setter，补充 aria-pressed；组名使用已有本地化文案。
- 两种语言、七种主题、桌面与 390px / 320px 窄屏均可操作，20px UI 字号不裁切或横向溢出。
- 文本对比度至少 4.5:1；选中边框与容器至少 3:1；键盘焦点可见。
- 只调整 SSH 表单投影，不改认证凭据、资源来源、连接准入、SSH/WSL/Docker 生命周期。
- 不添加主题专属硬编码颜色、额外持久化、DOM 测量状态或新服务调用。

## 所有者与接口

theme/setTheme 和 applyTheme 继续拥有主题事实与 DOM class；现有语义 CSS 变量提供颜色。
useRemoteConnectionForm 拥有 sshAuthMethod 与 assetInstallMode，字段组件由这些值派生选中状态，
点击或原生 Enter/Space 只调用现有 setter。没有新的跨端事件或业务状态。
Desktop 与手机 Web 共用 RemoteConnectionFields，远程 continuous/replayable 交付不变。

## 验收

1. 用真实 RemoteConnectionDialog 浏览器夹具先复现无 aria-pressed / 难辨边框，再修复。
2. 两个组每次只有一个已选项，点击和键盘切换更新认证字段与提交的 assetInstallMode。
3. 七种主题、中英文及桌面/窄屏/大字号检查已选背景、边框、文字、focus 和 hover 保持。
4. 保存截图人工检查；既有连接取消/迟到结果 E2E 不回归。
5. 根 typecheck、lint、changed architecture 与改动文件格式检查通过。

## 验证记录（2026-10-13）

先以浏览器回归复现旧控件缺少选择状态属性/组标识，再调整实际字段组件。
`remote-connection-switches.test.mjs` 与既有 `remote-connection.test.mjs` 串行执行：8 / 8 通过。
新场景覆盖七主题 × 中英文 × 三种宽度/字号，共 42 组；显式主题与 OS 明暗相反，
检查两组的选中背景、至少 3:1 边框、至少 4.5:1 文字、无裁切/横向溢出、hover、focus-visible、
点击/Space 切换，以及真实表单提交的下载方式。只调用受控连接 fixture，不建立真实 SSH。

保存 14 张截图于 `.tmp/remote-connection-switches/`，已人工查看落晖黄桌面和暗夜黑窄屏。
根 typecheck、lint、changed architecture 通过，baseline 0、new 0；改动文件格式检查通过。
模块为 legacy ui 与 web 浏览器测试；UI 源码净增 12 行、locale fixture 净增 1 行，新增 E2E 文件 155 行。
仅使用现有主题变量和表单 setter，主题/选择状态 owner 及同步顺序保持原合同；未构建安装包。
