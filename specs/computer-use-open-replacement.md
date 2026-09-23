# Computer Use 开源替代：本地驱动、Helper 与应用观测

## 背景与范围

`packages/zcode-cua` 现提供仓库内开放实现：本地输入驱动 seam、官方帧契约、带认证的 PiP 客户端/服务端与 macOS presenter、capability-authenticated Helper broker、xa11y 应用观测及 14 方法产品词表。公开 API、12 条 exports 子路径与既有失败文案保持兼容；产品路径不依赖私有 producer。

实现组成：

- 内部驱动采用 `@nut-tree-fork/nut-js`（实测 `npm view @nut-tree-fork/nut-js license version` → `Apache-2.0` / `4.2.6`，与包的 Apache-2.0 许可一致；本仓库已按 `pnpm add @nut-tree-fork/nut-js --filter @zcode/zcode-cua` 落地）。
- 驱动调用隔离在可替换 seam 之后，单测注入 mock。
- `createComputerUseRuntime` 公开签名、12 条 exports 子路径、fail-closed 语义与失败文案全部不变；`ComputerUseRuntimeOptions` 以可选字段接收 broker socket/capability/generation、日志与本地 seam 注入，`execute`/`closeSession`/`dispose` 签名不动。
- 应用观测与产品输入采用 `@crowecawcaw/xa11y@0.15.0`（MIT；Windows UI Automation、macOS AXUIElement、Linux AT-SPI2；Node 方法异步运行在 N-API worker pool），包括 `inputSim()` 原始输入。`@nut-tree-fork/nut-js` 只保留给本地驱动回归和显式 `e2e:local`，不用窗口标题、进程列表或截图裁剪伪造可访问性树。
- 产品 runtime 只做严格校验、排队和 Helper RPC；截图、观测和输入均在同一个 Helper 进程内完成。直接 nut-js runtime 仅供包内测试与显式 `e2e:local` 自检，不再是产品缺省组装。

本 spec 与 `specs/computer-use-decision-provider.md` 共同约束产品闭环。仍不在代码交付范围的只有：macOS/Linux 真机验收、发行证书/TeamIdentifier/公证凭据和用户选择的 UI-TARS 模型权重或 API 凭据；这些是外部环境或密钥，不得由仓库伪造。GitHub tag workflow 对 macOS、Windows、Linux 都只发布可供后续签名的未签名目录或安装包，使用者在仓库外自行完成平台签名/公证；本阶段只负责完整性校验、安装、启动和失败处理代码。配置为“必须签名”的产品安装路径仍 fail closed，不能把未签名产物伪装成已验证身份。

## 产品闭环

### 产品规则与动作面

1. 官方 SDK 的低层词表固定为 14 个方法：`list_apps`、`list_windows`、`get_app_state`、`left_click`、`left_click_drag`、`scroll`、`type`、`set_value`、`select_text`、`key`、`paste`、`perform_action`、`request_access`、`stop_computer_control`。这是当前仓库随附 `computer-use` 0.6.3 SDK 的 wire contract；本包不再把外部 producer 当作词表真相源。
2. 第一阶段的八个动作名继续作为包内本地驱动 seam 的兼容面；产品 SDK 请求进入 Helper 后统一投影到上述 14 方法。未登记方法和未知字段 fail closed。
3. `list_apps`、`list_windows`、`get_app_state` 只能读取 xa11y 返回的真实应用、窗口和 AX/UIA/AT-SPI 元素。平台未提供的字段返回 `null`，不得猜测 bundle id、窗口 id 或元素身份。
4. `left_click`/`left_click_drag`/`scroll` 的 target 是最近一次目标窗口截图的整数像素坐标 `[x,y]`，或最近一次 `get_app_state` 生成的元素 `index`。元素索引由 Helper 的 session snapshot owner 解析；过期、跨应用或歧义索引返回 `element_unavailable`，绝不退化成错误坐标。
5. `set_value`、`select_text`、`perform_action` 优先调用 xa11y 的语义动作；`type`、`key`、`paste` 和显式坐标动作才走原始输入。语义动作失败不自动重放为原始输入，避免动作可能已发送后的重复副作用。
6. `request_access` 只查询或触发 Helper 授权链；`stop_computer_control` 释放当前 `workspaceKey + sessionId` 的 lease、待执行队列和 snapshot，不等价于销毁全局 runtime。
7. 设置页的平台可用性由同一纯函数判定：本机 macOS、Windows、Linux desktop 均可启用 Computer Use；Web 以及 SSH、WSL、Docker 和其它远端 workspace 保持不可用。只有 macOS 本机展示 TCC 权限与系统设置引导，Windows/Linux 本机只展示插件与 composer 入口开关；UI 不得因 Linux 缺少 TCC 面板而把已打包的 Helper 能力标成不支持。

低层严格入参以 SDK 0.6.3 为准：

| 方法                    | 必要字段                                      | 可选字段                                                                          |
| ----------------------- | --------------------------------------------- | --------------------------------------------------------------------------------- |
| `list_apps`             | 无                                            | 无                                                                                |
| `list_windows`          | `app_ref`                                     | 无                                                                                |
| `get_app_state`         | `app_ref`                                     | `include_screenshot`、`disable_diffing`、`tree_shown_to_model`                    |
| `left_click`            | `target`                                      | `mouse_button`、`click_count`、`modifiers`、`strategy`、`app_ref`、`return_state` |
| `left_click_drag`       | `from_target`、`to`                           | `modifiers`、`app_ref`、`return_state`                                            |
| `scroll`                | `target`、`scroll_direction`、`scroll_amount` | `strategy`、`app_ref`、`return_state`                                             |
| `type`                  | `text`                                        | `target`、`app_ref`、`strategy`、`return_state`                                   |
| `set_value`             | `target`、`value`                             | `strategy`、`app_ref`、`return_state`                                             |
| `select_text`           | `target`                                      | `text_range`、`app_ref`、`return_state`                                           |
| `key`                   | `text`                                        | `repeat`、`hold_seconds`、`app_ref`、`strategy`、`return_state`                   |
| `paste`                 | `text`                                        | `format`、`app_ref`、`return_state`                                               |
| `perform_action`        | `target`、`action`                            | `app_ref`、`return_state`                                                         |
| `request_access`        | 无                                            | `capabilities`                                                                    |
| `stop_computer_control` | 无                                            | `reason`                                                                          |

`app_ref` 是含 `name?`、`bundle_id?`、`pid?`、`window_id?` 的严格对象，至少一个应用身份字段存在；`target` 只能是非负安全整数 element index 或两个安全整数构成的坐标元组。所有参数校验必须发生在权限探测与驱动调用之前。

### 状态所有者与事件顺序

- **AgentRuntime** 仍是唯一决策循环、取消、工具持久化和重试所有者；UI-TARS 只在模型适配层把一个完整文本 `Action:` 转成一个既有 `node_repl` 工具调用，不引入 SDK 自带 loop/operator。
- **Desktop Local Host** 拥有 Helper 进程 generation、socket、capability 和 workspace admission；Main 只负责安装、签名校验、系统设置引导和进程转发，不持有会话业务状态。
- **Helper broker** 是权限真值、控制 lease、动作串行队列、应用 snapshot 与元素 index 的唯一所有者。权限不缓存；每个读屏或副作用动作在实际执行位置重新裁决。
- **Helper PiP coordinator** 是 PiP 生命周期、焦点 revision、turn sequence、可信截图绑定和 presenter 可见性的唯一所有者。Host 只投递产品事实，不持有窗口状态；Main 只产生当前桌面窗口的焦点事实。
- **runtime** 不保存授权结论、AX tree 或元素表；只保存自己尚未发往 Helper 的排队项和生命周期状态。

```text
AgentRuntime（唯一决策循环）
  -> node_repl bridge（main-only + workspace/session context）
    -> createComputerUseRuntime（严格校验/取消/排队）
      -> Helper broker RPC（socket + Host authority capability + credential generation）
        -> 每次实时权限裁决
          -> xa11y 读取/语义动作 或 nut-js 原始输入
        <- CallToolResult + app association + snapshot/state/frame identity
      <- 失败统一折为既有 unavailable 形状
  <- 工具结果按现有 turn 持久化并进入下一次模型请求
```

动作已经下发 Helper 后的断连按 `possibly_sent` 处理，调用方不得自动重放；只读方法可按协议显式的 `retryable:true` 重试。`desktop-continuous` 与 `web-remote-replayable` 只改变结果投递/恢复，不改变 Helper 的 owner/lease 与 stale snapshot 防护。

### Broker 协议与权限

broker 使用 Node `net` 的 newline JSON，单帧上限 1 MiB（含截图的响应上限沿 node_repl 既有 32 MiB），首帧和每个请求都严格校验：

```text
{id, protocol:"zcode.cua/broker", version:1, capability, generation, method, params}
{id, ok:true, result}
{id, ok:false, error:{code,message,possibly_sent?,retryable?}}
```

- 控制方法为 `ping`、`broker_info`、`permission_status`、`execute`、`close_session`、`shutdown`；`execute.params` 承载上述 14 方法、参数和 context。为兼容现有 macOS 设置页的本机签名身份通道，前三个只读方法允许无 wire capability；它们不得触发权限提示或输入副作用。`execute`、`close_session`、`shutdown` 始终要求 capability + generation。
- socket 路径不是授权凭据。为兼容本项目已有 Host/Agent 身份链，broker **复用同一批下发的 `ZCODE_CUA_PLUGIN_AUTHORITY` 作为 capability**，不再制造第二份机密状态。当前 Host authority 在 Host 生命周期内稳定、重建 Host 时随机轮换，因此旧 Host authority、缺 capability、generation 不匹配、坏帧、超限、未知方法、Helper dispose 后请求均在触发权限/驱动前拒绝。比较使用常量时间实现。
- 常驻 Helper 的 capability 与 generation 不得出现在 argv、环境变量或 credential 文件。Windows/Linux Node fork 与 macOS 产品 Helper 统一使用父子进程 Node IPC 一次性 bootstrap；`ZCODE_CUA_PERMISSION_BROKER_SOCKET`、既有 `ZCODE_CUA_PLUGIN_AUTHORITY` 与 generation 只定向注入官方 `node_repl`，并继续从通用子进程环境剥离。当前 Agent-facing tuple 的兼容 generation 为 `0`；协议保留显式数字字段，后续轮换时无需改 wire。node_repl 自身的二级 broker token 保留，两跳各自防 confused deputy。

常驻 Helper 的 credential bootstrap 时序固定为：

```text
Helper 注册 IPC listener
  -> parent {protocol,type:"bootstrap_request",pid,nonce}
  -> Host 核对 exact child PID + nonce
  -> child  {protocol,type:"bootstrap_credentials",pid,nonce,capability,generation}
  -> Helper 严格校验并一次性消费
  -> 加载 xa11y / Linux preflight / bind PiP 与 broker sockets
```

两种 control message 都只接受精确字段集、有界字符串和安全整数；nonce 每个 child 随机生成，等待有界，坏帧、重复凭据、IPC 断开、超时或 PID/nonce 不匹配均在 native addon 加载与 socket bind 前 fail closed。Helper 必须先注册 listener 再发 request，Host 不得在 spawn 后盲发 credential。`permissionRequest` / `permissionPreflight` 是无凭据一次性模式，必须先于 bootstrap 判定，不等待 IPC tuple，也不得启动 broker。

- 产品 `createComputerUseRuntime` 必须真实调用 Helper；无法连接、握手错版、权限拒绝或响应非法均返回原失败形状。`ensureBrokerAvailable` 仅是额外健康门，不能代替逐次 Helper 执行。

### xa11y producer 映射

- `App.list()` 生成 `list_apps`；`App.byPid`/`byName` 与严格唯一匹配解析 `app_ref`；`App.windows()` 生成窗口列表。bundle id 仅在平台原始数据明确提供时返回，否则 `null`。
- `App.tree()`/元素递归遍历生成确定性 pre-order index、紧凑文本和结构化 `elements`。每次完整观察生成新的 `state_id`；snapshot key 为 `workspaceKey + sessionId + pid + window identity`。`disable_diffing:true` 强制全量；只有 `tree_shown_to_model:true` 的状态可成为增量基线。
- `get_app_state(include_screenshot:true)` 用 xa11y 对已解析窗口元素截图并返回官方帧三件套；帧引用携带本次解析出的严格 `appRef`，供文本动作模型在下一步绑定同一应用/窗口。截图失败不得抹掉已成功的 AX tree，需在结构化结果中给出 `non_actionable_reason`。
- 元素动作通过 snapshot 中保存的 xa11y Element handle 与稳定身份执行；每次动作前复核 app/window/snapshot owner。xa11y 报 stale/ambiguous 时映射为现有 broker 错误码。
- xa11y 原生包与 nut-js 原生包只进入独立 Helper 资源，不进入 desktop `app.asar` 或 node_repl bundle。

### 开放 Helper 的平台产物

- 三个平台必须从仓库内同一份 `helper-entry.js`、broker、producer 和驱动源码生成 Helper 资源，不得把私有 producer、预置的外部 Helper 二进制或仅开发机存在的绝对路径作为产品依赖。平台差异只允许位于受控的启动器、原生 xa11y/nut-js 包选择和系统权限适配层。
- Windows 与 Linux 使用受完整性清单约束的 Node Helper runtime。清单必须覆盖入口、递归 JS 闭包、所选平台/架构的 `.node` 与运行所需旁文件；启动前逐项校验哈希、拒绝缺失、额外文件、符号链接、大小写碰撞和平台/架构不匹配。Linux 选择 `@crowecawcaw/xa11y-linux-{x64|arm64}-gnu`，并保持本项目既有 RHEL 8+/glibc 2.28 发布基线：release workflow 必须从锁定的 xa11y 源码 revision 在 manylinux*2_28 对应原生架构环境构建 N-API addon，stager 必须校验 ELF 架构与最高 `GLIBC*\*` 符号版本不高于 2.28；npm 上游预编译包或任意 override 不满足该契约时终止出包，不能生成“可安装但 Helper 必然无法加载”的产物。
- Linux Helper 在发布 `transport_ready`/`ready` 和 Agent-facing credential tuple 前必须完成无输入副作用的能力预检：识别当前 X11 或 Wayland 会话，验证 AT-SPI `App.list()` 返回有效数组，并确认 xa11y `inputSim()` 可初始化后立即释放。Wayland 还必须由 **Helper 同一进程身份**验证 `/dev/uinput` 可写；不满足时返回稳定的 fail-closed 启动原因，不能等到首个 move/click/key/type 才失败。不得静默把用户加入 `input` group、安装扩大权限的 udev 规则或回退到绕过 broker 的输入路径；无显示环境、Wayland bridge、AT-SPI 或输入权限只拒绝本次启动，不能永久禁用 Linux 平台。
- macOS 产品资源中的 `ZCode Computer Use.app` 必须由仓库内构建脚本生成，bundle 内执行同一份开放 Helper runtime，并包含仓库内 Swift 源码构建的非激活浮动 PiP presenter；固定 bundle id 继续作为 TCC 身份。`Info.plist`、入口、Node executable、presenter、JS 闭包及 `@crowecawcaw/xa11y-darwin-{x64|arm64}` 原生文件全部进入清单。仓库与 GitHub workflow 只产出可签名的未签名 bundle/package；使用者下载后在外部对嵌套 Mach-O 与 bundle 自行签名、公证。对要求签名的安装模式，现有安装器仍复核 TeamIdentifier、架构、Gatekeeper 与签名并 fail closed。
- macOS 的 `CFBundleExecutable` 是 Node SEA Mach-O，不得是 shell wrapper。打包方必须显式提供 `ZCODE_CUA_MAC_NODE_EXECUTABLE`、与构建 Node 相同的 `ZCODE_CUA_MAC_NODE_VERSION` 和 `ZCODE_CUA_MAC_NODE_SHA256`；stager 在注入 SEA 前校验常规文件、SHA-256 与目标 `lipo` 架构，任一缺失或不匹配即终止出包。SEA bootstrap 只负责校验 bundle 内 Info/runtime 文件集并加载 `Contents/Resources/runtime/helper-entry.js`；Node 主 executable、PiP presenter 与 `.node` 允许由外部签名流程在打包后改写，清单将其明确标记为 `signedMutablePaths`，已签名安装模式的运行时身份复核由现有 `codesign --deep --strict`、TeamIdentifier 和 Gatekeeper 安装门承担。`CFBundleShortVersionString` 必须跟随桌面应用版本，`CFBundleVersion` 必须由 `ZCODE_CUA_HELPER_BUILD_ID`（缺省为同一份桌面 commit + build time 元数据）稳定派生为合法数字版本；不得复用独立 CUA 包版本，否则安装器可能把新发行包误判为同一 Helper 而保留旧产物。
- Helper 常驻 CLI 的规范参数固定为 `--socket`、可选 `--pip-socket`、`--parent-pid` 和 `--pip-mode`；`--capability`、`--generation` 及两个旧 `--allow-*-local-dev` 参数必须拒绝。`--parent-pid` 是新启动的唯一写出格式；孤儿回收在迁移期先识别它，并兼容读取旧进程的 `--launcher-pid`，不得因参数方言漂移漏掉当前 Helper。权限预检/提示保留无凭据的 `--permission-request` / `--permission-preflight` LaunchServices 方言，不进入常驻 bootstrap。
- macOS 常驻产品 Helper 必须直接 spawn 安装器已验证 bundle identity 返回的 `CFBundleExecutable` realpath，并配置 Node IPC stdio；直接执行同一 bundle 内已验证 Mach-O 保留其 code-signing/TCC 身份，不得复制到 bundle 外或改用 shell wrapper。Host 只在收到 child 的 bootstrap request 后经 IPC 回 credential，发送完成后断开 bootstrap channel；health 必须同时核对固定 bundle id 与 exact child PID。权限 request/preflight 仍使用 `/usr/bin/open` 启动同一 Helper.app，且永不接收 credential。
- Desktop Local Host 仍是唯一启动/重启 owner。Windows、macOS、Linux 均按需启动同一协议版本；平台启动失败不得退回进程内 nut-js 或绕过 broker。开发根目录与打包 runtime 必须按目标平台分别消费 `windows` / `linux` contract，不能用字段当前相同作为跨平台复用理由。已有配置无需迁移，关闭 CUA 的显式开关在三平台保持有效。

macOS product Helper 的稳定 transport、当前 Helper PID 与重启串行化只由 `createProductCuaHelperHost` 持有。`shutdown` 回包只表示请求已接收，不表示进程已经退出；复用同一路径的重启顺序固定为：

```text
Host shutdown request -> Helper ACK -> Host 等待已记录 PID 确认退出
                                      -> unlink 旧 transport
                                      -> beforeFreshStart
                                      -> 新 Helper 绑定同一路径
```

PID 缺失或在有界期限内仍存活时，重启必须 fail closed，保留旧 handle 并拒绝 unlink/rebind；不得让旧 Helper 的尾部 socket 清理删除新 Helper 刚绑定的路径。普通停止也沿用同一退出屏障，保证“transport 可复用”只有一条判定路径。

### 官方 Computer Use 插件发布单元

- `computer-use@zcode-plugins-official` 的唯一源码位于仓库内 `apps/zcode-cli/packages/zcode-cua-plugin`。该包只包含公开的 plugin manifest、`docs/computer-use.md`、`scripts/computer-use-client.mjs` 与 `skills/computer-use/SKILL.md`；不得从用户 plugin cache、私有 producer 仓库或开发机绝对路径补齐任何发布文件。
- Computer Use plugin 是 SDK/文档/skill 内容包，不拥有独立 MCP server 或 native runtime。`node-repl-host` 仍是唯一可执行 host，通过 `Symbol.for("zcode.node-repl.computer-use-bridge")` 向 SDK 注入受上下文约束的 broker bridge；公开 plugin id、`node_repl` host 依赖和 `agent.computerUse` SDK 入口保持稳定。
- Desktop 开发 staging、Desktop release staging 与 standalone SEA 必须从同一份仓库源码复制/嵌入该包。三条路径都至少校验 manifest、文档、SDK client 和 skill；任一文件缺失、manifest name/version 不匹配或 SEA 哈希清单不包含该包时终止构建，不得回退读取已安装 cache。
- official definition resolver 只允许解析受控的仓库/staging root candidate，并沿用现有 seed 完整性校验；用户 cache 是安装输出，不是源码候选。Computer Use 默认启用状态和远程 workspace 能力边界不因本发布修复改变：没有 `node-repl-host` 与本地 Helper 的环境仍不得宣称可用。
- 验收必须覆盖：空临时目录中的 staging 可独立得到完整 plugin；SEA collector 产出带哈希的四项 seed；official definition resolver 在仓库源码与 staged tree 中解析相同公开 id/version；SDK 只通过注入的 node_repl bridge 调用 broker，bridge 缺失时 fail closed。

### node_repl 凭据恢复边界

- Desktop Local Host 是 Helper socket、plugin authority、generation 与 refresh marker 的唯一所有者。Agent CLI 入口必须在通用工具环境形成前把 socket、authority 和可选 marker 从 `process.env` 清理进进程内快照；Bash、第三方 MCP 与普通子进程不得继承它们。
- 只有 resolver 标记为官方 Computer Use、且同时标记为共享 `node_repl` host 的 `__zcode-plugin-host` 调用可以消费该快照。它必须在调用可信 server 的 `main()` 前临时恢复完整的 socket + authority + 可选 marker，`main()` settle 后在 `finally` 中逐字段恢复原环境；只恢复 socket 会形成半组凭据，`captureComputerUseRuntimeFromEnvironment()` 必须继续 fail closed，不得退回本地 driver。
- `ZCODE_CUA_PLUGIN_AUTHORITY` 是 Local Host 下发并由可信 plugin host 恢复的唯一 capability 真值。遗留的 `ZCODE_CUA_PERMISSION_BROKER_CAPABILITY` 不属于当前 Host tuple：CLI sanitization 与 tool-env passthrough 必须将其剥离；即使父进程环境残留该键，`node_repl` 也必须优先使用可信 plugin authority，不能让遗留值覆盖本次 Host authority。
- generation 不是授权秘密，继续由该 server 的定向配置环境传递；`node_repl` 在 `main()` 生命周期内、MCP initialize 之前一次性捕获 runtime。官方 host 之外不得新增第二条凭据恢复路径，也不得为了热启用把凭据写入持久化配置。
- 回归验收必须真实执行 CLI sanitization → trusted plugin host → 临时 server `main()`：server 内能同时读取 socket、authority、marker 与 generation；调用结束后三个被清理的字段恢复为调用前状态。聚焦测试还必须证明遗留 capability 不进入 sanitized/tool passthrough 环境，且 authority 与污染 capability 同时存在时 runtime 选择 authority。缺 authority、非官方 plugin id 或非 `node_repl` marker 均不得启动带凭据的 server。

### 运行时启停收敛

- `isZCodeCuaInternalFeatureEnabled` 只表示开发/内部环境对产品配置门的显式 bypass，不是正式版 Computer Use 的默认值，也不拥有插件启用状态。未设置环境变量、空字符串、`0`、`false`、`off` 或任意未知值都必须返回 `false`；只有忽略大小写与首尾空白后的 `1`、`true`、`on` 能显式开启。
- `ZCODE_CUA_DEV_MODE` 是一键本地开发开关，显式真值时优先开启 internal feature；否则才读取 `ZCODE_CUA_PRODUCT_HELPER`。正式产品路径仍由 `computer-use@zcode-plugins-official` 的持久化配置决定，不能用 internal gate 的缺省值绕过用户关闭状态。

| `ZCODE_CUA_DEV_MODE` | `ZCODE_CUA_PRODUCT_HELPER` | internal feature |
| -------------------- | -------------------------- | ---------------- |
| 未设置/假值/未知值   | 未设置/空值/假值/未知值    | `false`          |
| 未设置/假值/未知值   | `1` / `true` / `on`        | `true`           |
| `1` / `true` / `on`  | 任意值（含显式假值）       | `true`           |

- 官方 Computer Use 必须始终进入 seed/catalog/discovery 面；缺少 `defaultEnabled` 只让它默认关闭，不能把它从插件列表或内置插件恢复入口删除。持久化的 `enabledPlugins[id]` 是正式产品启用状态的唯一所有者，internal feature 不得改写该配置或插件元数据。
- 默认 Helper factory 只回答“当前平台是否具备产品 Helper 资源”：Windows、macOS、Linux 可用，`ZCODE_CUA_PRODUCT_HELPER=0|false|off` 是显式资源硬关闭。实际创建仍需通过 desktop-local、本地 workspace、未注入 resolver，以及“插件配置已启用或 internal bypass 已开启”的 admission；两层不得复用同一个布尔门。
- 被 `suppressedBuiltins` 隐藏的 Computer Use 必须继续出现在 `restorableBuiltins`，恢复操作也不得要求 internal feature；恢复只清除 suppression，不隐式启用插件。

| internal bypass | `enabledPlugins[computer-use]` | Helper 硬关闭 | 插件面             | Helper admission                    |
| --------------- | ------------------------------ | ------------- | ------------------ | ----------------------------------- |
| `false`         | 未设置/`false`                 | 否            | 可发现、关闭       | 拒绝                                |
| `false`         | `true`                         | 否            | 可发现、开启       | 允许，仍受 desktop-local 等边界约束 |
| `true`          | 任意值                         | 否            | 仍按持久化配置展示 | 允许，仍受 desktop-local 等边界约束 |
| 任意值          | 任意值                         | 是            | 仍按持久化配置展示 | factory 不可用                      |

- `plugins/setEnabled` 的配置写入由 plugin-management 专用 Agent 承担；workspace 主 Agent 的 plugin outcome、runtime features、MCP 与 skill 快照仍只在 runtime 创建时确定，不伪造会话内热更新。
- 官方 Computer Use 启停写入成功后，Host 侧 `IPluginManagementService` 必须通过公开的 `IZCodeAgentService.disposeWorkspace()` 只失效同一 `workspaceIdentity?.trim() || workspacePath` 的主 Agent。plugin-management lane 与 Helper 生命周期不随之销毁；下一次会话请求按新配置重建 Agent、重新取得 Helper tuple，并恢复原 session。配置写入失败不得失效 runtime。
- runtime cleanup 即使最终报告失败，旧 client 也已先从复用池移除且 generation 已推进；该失败只能记 `warn`，不得把已经落盘的插件状态回滚成旧值。Helper 仍由下一次 Agent spawn 的既有懒启动边界创建，不从 Renderer 增加第二条启动路径。
- workspace 任一 task 正在 `creating` / `restoring` / `streaming`、存在 active input，或 task index 仍为 `running` 时，Computer Use 专页与通用插件页都必须禁用该插件开关；两处复用同一个 workspace busy 纯函数，不能各自维护判定。服务层的 runtime 失效仍是最终一致性边界，UI busy 门用于防止正常产品路径中断已接纳的 turn。
- 回归验收覆盖：CUA 写入成功只失效目标 workspace 一次；其它插件不触发该专用失效；写入失败不失效；cleanup 失败不回滚成功结果；两处 UI 消费的共享 busy 判定覆盖 runtime 与 task-index 两条运行中事实源。

### 轨迹与可测性

原始坐标动作支持 `instant` 与 `smooth` 两个内部 motion profile。`smooth` 由确定性路径生成器产生有界分段轨迹，测试可注入 clock/driver；Helper 通过显式 `ZCODE_CUA_MOTION_PROFILE=instant|smooth` 配置 xa11y producer，缺省保持 `instant`，非法值必须在动作执行前拒绝。该配置只改变坐标 click/drag/scroll/type-target 的指针移动，不改变元素语义动作、权限、目标绑定或 stale-frame 校验；首个未知指针位置退化为一次直达，后续已知坐标间才生成平滑路径。记录的诊断只含动作类别、路径点数、耗时、结果码和匿名域 key，不含截图、文本、坐标或应用私有数据。所谓“90%+”必须由版本化回放集/真实同意样本计算，代码不得硬编码成功率或靠超时掩盖同步。

### 产品闭环验收

1. broker parser/client/server 覆盖分片、多帧、上限、超时、中止、坏 capability、旧 generation、动态权限变化和 `possibly_sent`；拒绝路径驱动零调用。
2. xa11y adapter 用 mock App/Element 覆盖 14 方法、确定性 index、stale snapshot、跨会话隔离、全量/增量、截图成功与独立失败；Windows 真机覆盖真实 UIA 树、元素动作、窗口截图和 DPI。真机自检必须遍历枚举结果，选择首个同时返回有效 UIA tree 与官方 PNG frame 的窗口；不得假设首个系统窗口一定可截图，也不得把单个受保护或瞬态窗口误判成 Helper 全局不可用。
3. Windows/Linux Helper 子进程覆盖 bootstrap request/credential 的严格字段、超时、坏 PID/nonce、重复消息、transport-ready、exact PID health、真实截图/动作、shutdown、父进程退出回收和旧 capability 拒绝；argv 与 child env 断言不得出现 capability/generation。
4. Linux runtime 与 macOS Helper.app 的目录构建、平台/架构包选择、完整性清单、标准 CLI 参数和 Local Host 组装必须有无真机依赖的测试；macOS 还必须覆盖 PiP presenter 的目标架构编译输入、清单与签名边界；Linux 还必须覆盖 dev-root 平台 contract 选择、ELF 机器类型、glibc 2.28 上限、release addon override，以及 X11 允许、Wayland `/dev/uinput` 拒绝/允许和无显示会话拒绝的启动预检。真机 TCC/Retina/AT-SPI/PiP 验收按用户要求暂不作为本阶段完成门槛。
5. 设置页 availability 单测覆盖本机 macOS/Windows/Linux 均可用、Web 不可用，以及任意 desktop 平台一旦带远端 session/target/identity 就保持不可用；Computer Use 分区与插件列表必须消费同一判定，不保留 Linux 专用的不可用分支。
6. desktop native package policy 明确拒绝 `app.asar` / unpacked app 中的 `@nut-tree-fork` 与 `@crowecawcaw/xa11y*`；Helper resources manifest 对 entry、JS、`.node` 与旁文件逐项 SHA-256 校验。该检查用 `electron-builder --dir`/asar 列表即可执行，不依赖签名安装器。
7. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、包内 `node --test` 与 license check 全部实际执行并如实报告。
8. `e2e:helper` 必须启动仓库内真实 Helper 子进程，响应 child bootstrap request 后才经 IPC 下发 capability + generation，再由 broker 链调用公开 `createComputerUseRuntime`；验证 `list_apps`、目标应用 `get_app_state(include_screenshot:true)` 的真实 AX/UIA 树与官方帧，并在 `closeSession` 后通过认证 `shutdown` 回收。脚本默认跳过，只有显式 `ZCODE_CUA_HELPER_E2E=1` 才读取桌面，且不发送鼠标或键盘副作用。
9. CLI plugin-host 集成测试必须覆盖完整凭据 tuple 的临时恢复与 finally 清理；Windows 产品回归须从已打包 `node_repl` 发起一次 `list_apps` 或绑定目标应用，不能只以 Helper ready 判定可用。
10. 从关闭态启用 Computer Use 后，当前 workspace 的旧 Agent 必须失效；下一次请求创建的新 Agent 同时具备 `runtimeFeatures.computerUse=true` 与完整 Helper tuple。运行中的 workspace 不得由设置页触发该换代。

## 本地驱动兼容 seam

### 动作面

1. 仅供包内单测与显式 `e2e:local` 的本地 seam 实现八个动作：`screenshot`、`move`、`click`、`double_click`、`drag`、`type`、`key`、`scroll`。它不作为产品 fallback。
2. 产品 runtime 经 Helper broker 执行前文 14 方法；`get_app_state`、`list_apps`、`list_windows` 等由 xa11y producer 实现，不经过本地八动作 seam。历史方法 `capture_app` 和其它未登记名继续 fail closed。
3. 新增产品或 seam 动作都必须先更新本 spec（含入参契约与验收矩阵行）。

### 动作入参契约（`execute` 的 `arguments` wire 形状）

`arguments` 是桥层透传的 `unknown`（`cua-broker.ts:90-97` 把 `{id,token,method,input,context}` 的 `input` 原样塞进 `arguments`），其 JSON 形状由本节唯一定义。runtime 做严格校验；任何非法参数（缺字段、类型错误、非安全整数、未知字段、枚举外取值、`arguments` 不是普通对象）与未登记方法同等对待：返回占位失败形状（见下），不新增第二种错误形状，也不向模型回显参数细节——失败文案固定，暴露更多错误类别等于向未放行调用方确认 runtime 存活。

| 动作           | `arguments` 形状                    | 校验规则                                                                                  |
| -------------- | ----------------------------------- | ----------------------------------------------------------------------------------------- |
| `screenshot`   | `{}` 或缺省                         | 除空对象外不得携带任何字段                                                                |
| `move`         | `{x, y}`                            | `x`/`y` 必须是安全整数（`Number.isSafeInteger`）                                          |
| `click`        | `{x, y, button?}`                   | 同上；`button?` ∈ `"left" \| "right" \| "middle"`，缺省 `"left"`                          |
| `double_click` | `{x, y, button?}`                   | 同 `click`                                                                                |
| `drag`         | `{fromX, fromY, toX, toY, button?}` | 四个坐标同上；`button?` 同 `click`（nut-js 原生 `drag()` 仅左键，按住-移动-松开自行组装） |
| `type`         | `{text}`                            | `text` 必须是 string（空串放行，由 nut-js 原样处理）                                      |
| `key`          | `{key}`                             | `key` 必须是下表内的键名字符串；表外取值非法                                              |
| `scroll`       | `{direction, amount}`               | `direction` ∈ `"up" \| "down" \| "left" \| "right"`；`amount` 为 > 0 的安全整数           |

**键名词表**（`key` 的合法取值，driver 侧映射到 nut-js `Key` 枚举）：

- 字母 `a`–`z`、数字 `0`–`9`（映射 nut-js 顶排数字键 `Num0`–`Num9`）、功能键 `f1`–`f24`；
- 命名键：`enter` `tab` `escape` `space` `backspace` `delete` `insert` `home` `end` `pageup` `pagedown` `up` `down` `left` `right` `minus` `equal` `grave` `comma` `period` `slash` `semicolon` `quote` `leftbracket` `rightbracket` `backslash` `capslock` `numlock` `print` `scrolllock` `pause`。
- 词表**大小写敏感**：上表与单字符规则均按小写定义，大写/混合取值（如 `ESCAPE`）非法。
- 起步不支持组合键与修饰键（`ctrl+c` 等）：词表是单键 tap，组合键属 producer 权威词表的能力，需要时先改本 spec 再扩表。
- **词表校验归属（评审定死的修订）**：`ComputerUseRuntimeOptions.isKnownKeyName?: (name: string) => boolean` 注入词表谓词，runtime 在 ① 廉价预检阶段拒绝表外键名——不入队、不触 gate、不产生 broker 可用性调用。默认组合（`index.js`）注入驱动词表纯函数 `resolveNutKeyName`；未注入时保持既有行为（由驱动侧拒绝），mock 驱动测试可注入自己的谓词。runtime 不耦合具体驱动的词表实现。

**坐标与 DPI 换算规则**：

- `x`/`y` 的单位是**本 runtime 最近一次 `screenshot` 返回光栅的像素坐标**（与 `tool-contract.ts:48-49`「整像素、raster 内契约」一致）。runtime 只校验整数性，不校验范围；越界由 OS 截断，不视为运行时错误。
- 指针坐标与截屏光栅的 DPI 语义**在本 driver 内对齐**：nut-js 的 `mouse.setPosition` 吃的是它自己的屏幕坐标系（DPI 缩放下的逻辑坐标），而 `screen.grab()` 返回物理像素光栅。driver 在每次 `screenshot` 时记录换算比例 `scale = screen.width()/rasterWidth`、`screen.height()/rasterHeight`，后续指针动作执行 `logicalX = Math.round(x * scaleX)` 后再交给 nut-js；ratio 在下一次 screenshot 前保持不变（分辨率热切换的陈旧窗口是已记录的已知限制）。真机实测证据（Windows 11，2560x1440 物理 @150%）：`screen.width()/height()` 返回 `1707x960`（逻辑），`screen.grab()` 返回 `2560x1440`（物理，BGRA、`pixelDensity≈1.5`）——不换算时点击会系统性偏移 1.5 倍。尚无 screenshot 前的指针动作按 1:1（scale=1）执行。
- `screenshot` 返回**官方帧三件套**：`content:[{type:"image", data:<PNG base64>, mimeType:"image/png"}, {type:"text", text:<帧引用 JSON>}]` + `_meta[OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY]`。帧引用 JSON 的线格式与校验规则唯一定义在 `frame-contract.js`（见「官方帧契约」节）；引用文本携带栅格宽高——模型的指针坐标系契约（`x`/`y` 按最近一次截图光栅解释）。nut-js 内存抓屏（`screen.grab()`）给的是 BGR(A) 原始缓冲，包内自带一份基于 `node:zlib` 的 RGB PNG 编码器（内部模块，见「接口」），不引入第二个图像依赖。产物不设尺寸上限：模型侧 inline 上限由 core 的 exact-raster 保留路径处理（超限帧经 `imageProcessorPort` 压缩且引用宽高同步改写），bridge 层 32 MiB 响应上限不变。
- **成功返回形状**：`screenshot` 如上返回 image 内容块；其余动作成功返回 `{ content: [] }`（`CallToolResult` 允许空 content），不发明额外文案。
- `scroll` 的 `amount` 是滚轮「步数」，nut-js 语义（单步实际距离 OS 相关），runtime 不做像素换算。

### fail-closed 语义（不可漂移）

权限不足、凭据缺失、驱动缺失、方法未登记、参数非法、平台不支持、驱动执行异常、`signal` 中止、`dispose` 之后调用——一律返回与占位完全相同的失败形状（唯一定义点 `packages/zcode-cua/runtime.js:9,26-28` 的 `UNAVAILABLE_TEXT` / `unavailableResult`；公开入口 `packages/zcode-cua/index.js:8`）：

```
{ content: [{ type: "text", text: "Computer Use is not available in this build." }], isError: true }
```

- 文案一字不改；不静默成功；不把不可用伪装成部分成功。
- `execute` 以返回值表达失败，不向调用方抛异常（桥层 `cua-broker.ts:99-104` 会把异常折叠成 `{ok:false,error}` 协议错误，丢失 `CallToolResult` 形状）。
- `runtimeScope === "subagent"` 的请求 fail closed。桥侧已有第一道门（`cua-bridge.ts:8` `CUA_UNAVAILABLE_IN_SUBAGENT_MESSAGE`、`:45-46` 抛错），runtime 内保留第二道纵深防御。
- **`signal` 中止的结束形状**：`signal` 在调用前已中止、排队等待中中止、或驱动执行中中止，`execute` 一律以占位失败形状（原文案 + `isError:true`）返回，不向桥抛 `AbortError`（抛出会被 `cua-broker.ts:100-105` 折叠成 `{ok:false,error}`，破坏形状）。nut-js 动作不可协作式取消：排队中中止的调用**立即**返回失败且永不下发驱动；驱动执行中中止的调用在驱动动作自然结束后返回失败——**已经发出的动作副作用（已移动的光标、已输入的键）不回滚、不撤销**，这是记录在案的边界而非缺陷。

### 本地 seam 的权限门

本地 seam 执行前必须确认放行；它只用于包内注入测试与 `e2e:local`，不进入产品组装。产品 runtime 始终携带 socket + capability + generation 调 Helper，权限在实际执行处逐次裁决，不回退到本 seam。seam 自身不判定 TCC、不缓存结论、不实现探针：

- runtime 构造时经 `ComputerUseRuntimeOptions`（`index.d.ts:27-32`：`brokerSocketPath?` / `refreshMarkerPath?` / `ensureBrokerAvailable?` / `env?`，新增可选 `logger?` 见「日志注入点」）持有 broker 凭据面；权限门（seam 的一部分）要求凭据存在且 `ensureBrokerAvailable()` 成功才放行本地驱动。
- seam 缺省门只把 trim 后非空的 `brokerSocketPath` 当作测试凭据；`options.env` 与 `refreshMarkerPath` 不参与。提供 `ensureBrokerAvailable` 时必须成功 resolve，reject/抛错均拒绝。产品入口不使用这一简化谓词。
- 无凭据环境 fail closed——与 `packages/services/src/node.ts:1148-1150` 的既有理由一致：空 env 会让未授权执行主体绕过 Helper broker 成为 TCC 主体。占位替换不得制造第二条绕过 Helper 的执行路径。
- 每次有驱动副作用的 `execute` 都重新过门（gate 不缓存结论；排队到实际执行时才调用 `authorize`）。

### 隐私与安全不变量

- `shouldRunCuaScreenCaptureProbe` 等「省略 options 是否主动抓屏」谓词继续从 `@zcode/zcode-cua/broker/ports` 纯子路径复用（`packages/services/src/cua-permission-broker/cuaPermissionService.ts:43-49`），本次不改 `broker-ports.js` 的任何谓词。
- 本地截屏只发生在已放行的 `execute` 调用内；不新增旁路进程抓屏。
- UI 侧仍然只可 import 纯 ports 子路径与类型；Node-only 面留在 services/host 层。
- 本地截图**签发** official-frame integrity metadata（`OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY`）。这是对首版 spec「不签发」决策的有意反转（第二阶段任务要求补齐帧契约）：开源 build 里该标记的语义是「本 runtime 真实截取的栅格」，让 core 归一化层走 exact-raster 保留路径、坐标契约不被通用落盘路径破坏。**它不构成防伪造签名，也不参与特权判定**——`officialCuaAuthorityVerified` 只认 server 白名单（`core/src/mcp/index.ts:71-72` 的 `officialCuaServerNames`），permission capability group 不会因帧标记而放行；第三方进程仿造帧标记的后果上限是「自己的图片不被压缩/落盘」，无提权面。

## 状态与所有者

- **权限状态唯一所有者：cua-permission-broker**。VALUE descriptor 由 services 层持有（`cuaPermissionService.ts:53-55`，通道 `ServiceChannels.CuaPermission = "cua-permission"`，`packages/shared/src/channels.ts:87`），实现对象由 `packages/services/src/node.ts:1872-2057` 装配（darwin 门 `:1878-1883`、插件开启门 `:1886-1895`）。runtime / `execute` / 驱动 seam **不得另存权限结论副本**（granted/stale/denied 一概不缓存、不镜像、不推导）；macOS 上 `screenRecording` 真值必须来自新进程探测的既有语义不变（`node.ts:1954-1956`），runtime 不自建等价探测。`queryScreenRecordingPreflight` 必须经 LaunchServices 以已安装的同一 Helper.app 身份启动一次性 `--permission-preflight screen_recording` 进程，等待退出并严格解析有界诊断记录；该进程不得携带 broker capability。启动失败、超时或诊断不合法返回 `undefined`，由 services 沿用既有报告值，不能伪造 granted/denied。
- **runtime 内部可持状态**（生命周期归 `createComputerUseRuntime` 返回对象）：
  - 驱动 seam 实例；
  - 执行串行化队列（并发互斥的唯一所有者，见行为矩阵第 9 行）；
  - driver 内的 DPI 换算比例（仅由本 driver 的 `screenshot` 更新）。
- `closeSession(context)` 的行为（评审定死）：结束**会话级**待执行工作——把该会话（按 `workspaceKey` + `sessionId` 二元组标识）仍在执行队列里排队的调用立即以失败形状结束，防止会话已关闭后动作迟到下发；幂等；不等待、不取消在途驱动调用（nut-js 动作不可中止）；**不释放**共享驱动实例、不影响其它会话；`dispose()` 之后调用是安全空操作。
- `dispose()`：标记 runtime 终止、排空全部排队调用（失败形状）、释放驱动并幂等；在途调用自然结束后同样以失败形状返回。
- **workspaceKey 规则不变**：`workspaceIdentity?.trim() || workspacePath`（`cua-broker.ts:123-130` 已按此回落），runtime 不重算、不落盘。
- 无第二写入路径：本地动作只经 `execute` 一个入口；桥与 runtime 之间沿用既有协议（一行 JSON `{id,token,method,input,context}`、1 MiB 上限、token `timingSafeEqual`，`cua-broker.ts:13,77-115`）。

所有者与事件顺序（单次 `execute`，全程占一把串行队列槽位）：

```
Agent 循环（决策层，不换）
  └─ MCP / node_repl 桥（cua-bridge.ts：subagent 拒绝、_meta 应用身份）
       └─ runtime.execute({toolName, arguments, context, signal})   [唯一入口]
            ├─ ① 廉价预检（未登记 toolName / subagent / 参数非法）→ 失败形状，不入队、不触 gate
            ├─ ② 入串行队列（与其它 execute 调用互斥；signal 中止/会话关闭 → 立即失败形状并跳过）
            ├─ ③ 权限门（seam）：brokerSocketPath + ensureBrokerAvailable() → 失败形状 | 放行
            ├─ ④ 驱动 seam（可注入 mock）→ @nut-tree-fork/nut-js        [本地动作执行]
            └─ ⑤ 返回 CallToolResult（失败一律占位文案 + isError:true）

权限真值（不在上图判定）：cua-permission-broker（services node.ts 装配）
  └─ standalone Helper broker RPC permission_status / 托管 host.queryPermissionStatus
       └─ UI 经 accessor 只读消费（accessor.ts）
  凭据下发（上图 ③ 的输入）：desktop/CLI 只在 Helper broker 就绪后把
  ZCODE_CUA_PERMISSION_BROKER_SOCKET 定向注入 zcode-cua/node_repl 的 env
```

## 接口

### 公开签名（不变）

- `createComputerUseRuntime(options?: ComputerUseRuntimeOptions): ComputerUseRuntime`（`packages/zcode-cua/index.d.ts:34-36`），返回 `{ execute, closeSession, dispose }`（`:21-25`），入参类型 `:14-19` / context `:1-12` 均不变。
- `package.json` 的 12 条 exports 子路径面不变（`packages/zcode-cua/package.json:8-57`）；不新增 subpath，避免与 producer API 兼容面、插件 version（`official-plugin-definitions.ts:396-398`，0.6.3，由原子 producer bump 维护）联动漂移。

### 日志注入点（评审定死）

- `ComputerUseRuntimeOptions` 新增**唯一**的可选成员 `logger?: ComputerUseRuntimeLogger`（`index.d.ts` 手写类型同步新增该接口；`debug?/info?/warn?/error?` 全可选，方法签名与 `@zcode/contracts` 的 `Logger`（`apps/zcode-cli/packages/contracts/src/logging/logger.ts:82-88`）结构兼容，宿主可直接传入既有 logger）。这是对「公开签名不变」的唯一豁免：函数签名、既有字段、`execute` 入参、context 与 12 条子路径全部不动，调用方零改动。
- runtime 只在**低频异常路径**落 `warn`，共四点（门拒绝 `gate_denied`、驱动动作异常 `driver_failed`、驱动 dispose 异常 `driver_dispose_failed`、会话关闭丢弃排队调用 `session_queued_drained`），不落 `debug/info`（无高频事件），不落成功路径。禁 `console.log`；缺省（未注入 logger）零日志。
- 组装点已接 logger：`server.ts` 的 `captureComputerUseRuntimeFromEnvironment` 注入 stderr 直写 logger（`node-repl-host` 不依赖 services logger，与本文件 process guards 同通道），driver 级失败在生产可观测。

### 内部驱动 seam（新增，不进 exports）

- 包为 flat `"type":"module"` 纯 JS + 手写 `.d.ts`、无构建步骤（`ls packages/zcode-cua` 实测），驱动实现保持同构，不引入构建链。
- 包内新增内部模块（**全部不列入 exports**，包外只能经 `"."` 入口取得默认组合）：
  - `cua-driver.js` + `cua-driver.d.ts`：`CuaInputDriver` 接口：`screenshot` / `move` / `click` / `doubleClick` / `drag` / `type` / `key` / `scroll` / `dispose`，全部异步；键名词表与 DPI 换算的纯函数（键名解析、scale 计算、逻辑坐标取整）具名导出供包内单测直接覆盖（不触原生 addon）。默认实现 `createNutJsDriver()`：内部 `await import("@nut-tree-fork/nut-js")`（异步动态 import；import 失败或原生 addon 缺失 → 归一为 fail-closed 失败形状，进程不 crash）。nut-js 类型不跨包泄漏。
  - `runtime.js`：权限门工厂 `createBrokerPermissionGate(options)` 与 `createComputerUseRuntimeWithDriver(driver, gate, options)`（注入点，供包内单测组装 mock 驱动 + mock 门）、参数校验、串行化队列、`closeSession`/`dispose` 语义。公开入口 `createComputerUseRuntime` 固定组装默认门 + 默认驱动。
  - `png.js`：RGB → PNG 编码（`node:zlib` deflate + 自含 CRC32），供 `screenshot` 把 nut-js BGR(A) 内存帧转 PNG，无第三方图像依赖。
- 测试落点（评审定死）：`packages/zcode-cua/index.test.js`——与源码同目录的 `node:test` 用例（本仓库惯例是 `*.test.ts` 与源码同目录，如 `apps/zcode-cli/packages/adapters/src/exec/nul-redirection.test.ts`；本包无构建链，故用 `.js` 直跑）。运行入口为包内新增 script `"test": "node --test index.test.js"` → `pnpm --dir packages/zcode-cua test`。该包不在 root typecheck 工程列表（root `package.json:29`），其 `.d.ts` 类型正确性由消费方（services/core/node-repl-host）的 typecheck 覆盖；`index.test.js` 是 JS，不进 tsc。

### 依赖与第三方登记

- `@nut-tree-fork/nut-js` 进 `packages/zcode-cua/package.json` `dependencies`。该文件的精确 sha256 已被 `third-party/inventory.json:2673` 锁定，改动后必须执行 `node scripts/licenses.mjs check`（Apache-2.0 属 green 分类，`scripts/licenses.mjs:70-84`；非 green 需 WEAK_ALLOW 登记且退出码 1，`:89,107-108`）与 `node scripts/licenses.mjs notices` 重新生成 `THIRD-PARTY-NOTICES.md` 与 inventory 哈希。
- **安装可行性验收（评审定死）**：`@nut-tree-fork/libnut-win32/-darwin/-linux` 在 publish 期以 cmake-js 预编译、tarball 内直接携带 `build/Release/libnut.node`，`npm view scripts` 无 install 钩子（`prepublishOnly`/`build:*` 均不会在用户侧触发）。因此 `pnpm-workspace.yaml` 的 `allowBuilds` 白名单**无需**为其登记——验收命令：`pnpm add @nut-tree-fork/nut-js --filter @zcode/zcode-cua && pnpm install` 后，
  `ls node_modules/@nut-tree-fork/libnut-win32/build/Release/libnut.node`（darwin/linux 同理）必须存在；且 install 输出不得出现针对 `@nut-tree-fork` 的 ignored/skipped build scripts 警告（本仓库 node-linker=hoisted，2026-09-23 实测 `pnpm add` 全程零构建脚本跳过、四个 `.node` 产物全部就位）。若未来某版本引入 install 钩子，必须先把它加进 `allowBuilds` 并重新走本节验收，绝不允许 pnpm 静默跳过构建却让运行期才爆炸。
- 传递依赖说明：nut-js 4.2.6 依赖 `jimp@0.22.10`（其图像读写 provider 在 import 时装配）与 `@nut-tree-fork/libnut`（原生 addon 门面，import 时按平台 require 预编译 `.node`）。driver 对 jimp 无直接依赖，PNG 编码自含。
- **上游许可材料钉定（本次实际执行）**：`@nut-tree-fork/{libnut,shared,provider-interfaces,default-clipboard-provider}@4.2.6`、`buffer-equal@0.0.1`、`readable-web-to-node-stream@3.0.4`、`tr46@0.0.3` 七个包的 tarball 内无完整 LICENSE/许可段（前三者与后三者分别是 nut-js 与 jimp@0.22 传递拉入生产图的新包），已按仓库既有流程把上游许可文本钉进 `third-party/upstream/<sha256>.txt` 并登记 `third-party/npm-overrides.json`（Apache-2.0 用 canonical 文本，source 指向 apache.org；其余钉上游仓库 LICENSE/README 许可段，source 指向 raw.githubusercontent）；nut-tree/fork 仓库在 GitHub 已不可公开访问（404），故采用发行方 SPDX 声明（Apache-2.0）+ canonical 许可文本的组合。执行 `node scripts/licenses.mjs notices` 重生成声明与 inventory 后，`node scripts/licenses.mjs check` 通过（2026-09-23 实测：1829 个实装包，退出码 0）。

### 打包接线约束（评审定死，两处 bundler + 一处安装器）

- **desktop tsup**：`desktopNodeRuntimeExternals` 保留 `@nut-tree-fork/nut-js`，避免主进程 bundle 追入本地自检用原生 addon。产品 main/host/scheduler 不直接加载 xa11y 或 nut-js。
- **CLI esbuild**：node-repl host 把 `@nut-tree-fork/nut-js` external 化，避免 bundle 追入 `.node`；产品 Computer Use 仍通过 Helper broker，不从 CLI 进程加载本地 driver。
- **electron-builder 原生边界**：`createDesktopNativePackagePrunePatterns` 在复制阶段排除 `@nut-tree-fork/**`、`@crowecawcaw/xa11y/**` 与 `@crowecawcaw/xa11y-*/**`，afterPack 再扫描 packed/unpacked asar 双重验证。目标 xa11y 包只进入受 manifest 校验的 Helper 资源；desktop `app.asar` 内不得出现上述路径。

### 声明文案同步

三处对外声明必须同步反映当前实现：产品 runtime 通过开放 Helper broker 提供应用观测与输入，失败仍保持 fail-closed；不得再描述成占位包：

1. `NOTICE.md:24`（含 `index.js#L3` 锚点是否仍指向入口所在行）；
2. `packages/zcode-cua/README.md:3-7`；
3. `packages/zcode-cua/package.json:5` description。

失败文案本身保持原文，与声明更新互不冲突。

## 验收场景

### 行为矩阵（单测，mock 驱动 + mock 权限门注入；全部在 `packages/zcode-cua/index.test.js`）

| #   | 前提                                                           | 调用                                                       | 期望                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | -------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 已放行 + 驱动可用                                              | `execute({toolName:"screenshot"})`                         | 返回官方帧三件套（`content[0]` 为 image、`content[1]` 为帧引用文本、`_meta` 带 integrity 键）的 `CallToolResult`，`isError` 缺省；mock 驱动返回的 `data`/`mimeType` 在 image 内容块中原样出现、零改写，引用文本携带 mock 栅格宽高。下游 `hasOfficialCuaFrameAuthority`/`preserveOfficialCuaFrameResult` 保留路径由 `frame-contract.test.js` 覆盖（压缩、引用宽高同步改写、`_meta` 保留、块不丢弃） |
| 2   | 已放行 + 驱动可用                                              | `move`/`click`/`double_click`/`drag`/`type`/`key`/`scroll` | mock 驱动收到符合「动作入参契约」的归一化参数（坐标整数、`button` 缺省 `left`、`drag` 的 from/to、`scroll` 的 direction/amount、键名映射）；`click`/`type`/`key`/`scroll` 四列沿用原矩阵行。坐标遵守整像素、raster 内契约（`tool-contract.ts:48-49`）；真机上目标应用状态相应变化（手动项）                                                                                                        |
| 3   | 权限门拒绝（无凭据 / `ensureBrokerAvailable` 失败）            | 任意动作                                                   | 失败形状 + 原文案；不抛异常；驱动零调用；`ensureBrokerAvailable` 未提供时按缺省门谓词（仅 `brokerSocketPath`）判定                                                                                                                                                                                                                                                                                 |
| 4   | 驱动缺失（驱动方法抛错，模拟动态 import 失败/原生 addon 缺失） | 任意动作                                                   | 失败形状 + 原文案；进程不 crash；异常经注入 logger 落 `warn`                                                                                                                                                                                                                                                                                                                                       |
| 5   | 未登记 `toolName`（含 `get_app_state` 等 producer 面）         | 任意                                                       | 失败形状 + 原文案；gate 与驱动均零调用（廉价预检在入队前失败）                                                                                                                                                                                                                                                                                                                                     |
| 6   | `runtimeScope:"subagent"`                                      | 任意动作                                                   | runtime 侧失败形状；gate 与驱动零调用；桥侧 `CUA_UNAVAILABLE_IN_SUBAGENT_MESSAGE` 不回归（桥未改动，既有行为）                                                                                                                                                                                                                                                                                     |
| 7   | `dispose()` 之后                                               | 任意动作                                                   | 失败形状；`dispose` 重复调用幂等；`closeSession` 在 dispose 后安全                                                                                                                                                                                                                                                                                                                                 |
| 8   | `signal` 中止                                                  | 任意动作                                                   | 以占位失败形状（原文案 + `isError:true`）结束，不悬挂、不抛 `AbortError`：调用前已中止 → 驱动零调用；排队中中止 → 立即返回且永不下发驱动；执行中中止 → 驱动动作自然结束后返回失败（副作用不回滚，见 fail-closed 节）                                                                                                                                                                               |
| 9   | 并发 `execute`（评审定死）                                     | 同一 runtime 多个动作并发调用                              | 驱动调用严格串行（后一个开始前前一个已结束），每个调用独立拿到各自结果/失败形状——nut-js 鼠标/键盘是进程级全局资源，broker 虽每连接单请求（`cua-broker.ts:31-38,65-106`）但不约束跨 socket 并发，串行化由 runtime 队列唯一负责                                                                                                                                                                      |
| 10  | `closeSession(context)`（评审定死）                            | 会话 A 排队中调用 `closeSession(A)`                        | A 的排队调用立即失败形状且不下发驱动；其它会话不受影响；`closeSession` 幂等；不释放共享驱动；dispose 后调用安全                                                                                                                                                                                                                                                                                    |

### 平台行为

- **Windows**：安装包 staging 出受完整性清单约束的开放 Node Helper runtime，Host 按需启动并通过父子进程 IPC bootstrap 下发 capability/generation；命名管道只承载后续 broker RPC。Helper recovery 只收敛后续 admission，不回收已有 Agent。DPI：坐标换算规则见「动作入参契约」，150% 缩放真机已验证逻辑/物理双坐标系分歧。
- **macOS**：TCC 判定在 Helper broker（accessibility/screenRecording，`broker.d.ts:95-110`）；未授权 → fail closed + 原文案。本地驱动不得绕过 TCC 门；`screenRecording` 新进程探测必须启动同一已安装 Helper.app 的一次性 preflight 模式并等待其退出，screen-capture 端到端探针的既有语义不变（`node.ts:1954-1971`）。产品启动仓库构建出的开放 `ZCode Computer Use.app`，不再依赖私有 producer artifact。Retina 的逻辑/物理换算与 Windows 同机制（driver 按 screenshot 比例换算），真机待手动验收。
- **Linux**：产品 Local Host 与 Windows/macOS 一样按需启动仓库构建出的开放 Helper runtime；xa11y 使用 AT-SPI2。X11 走原生输入模拟器；Wayland 只有在同一 Helper 身份可写 `/dev/uinput` 且输入模拟器初始化成功后才进入 ready。无显示环境、原生包不匹配、accessibility bridge、`/dev/uinput` 权限或驱动初始化失败 → fail closed，不 crash、不发布凭据；不得因为未做真机验收而在平台谓词中永久关闭 Linux。

### 回归保护

- 12 条 subpath 的公开面不变：`isBrokerMethod` / `isReadOnlyBrokerMethod` 对未知值 fail closed；`host-display-contract` 常量与 16 KiB 上限不变。`request-access-contract` 做严格结构校验，`pip-session-node` 提供真实客户端。
- services 垫片不新增 `export *` 双 barrel（TS2308），新增符号显式列入 `cua-permission-broker/index.ts`（本次预期无新增）。
- 授权后重启继续走 `resolver.restart()` / `restartAfterPermissionGrant`（`node.ts:2036-2040`），不得裸 `host.restart()`——本替换不触碰该链路。
- 每次行为改动随 PR 补测试（seam 注入单测 + 失败形状断言）；真机场景（Windows 驱动生效、macOS TCC 拒绝、Retina 换算）由 `e2e-local.mjs`（`ZCODE_CUA_E2E=1`，真实截图 + 指针移动自检）与 PR 手动验收项覆盖。

## 官方帧契约（第二阶段实装）

`frame-contract.js` 的全部纯函数开源实装，是 producer（本 runtime）与消费方（core 归一化层、adapters 投影、node_repl result 投影）的唯一定义点：

- **线格式**：帧引用是一个紧凑 JSON 文本块，紧随 image 块之后；逐字段与字段集合严格校验（`type:"zcode_cua_frame_ref"`、`schemaVersion:1`、`authority` 等于 `zcode.cua/open-frame` 或以 `zcode.cua/open-frame/` 开头、非空 `frameId`、`contentProtection:"official_cua_frame_v1"`），任何字段不满足都不算官方帧引用。
- **判定函数**：`isOfficialCuaImageRefText`（整块引用）、`containsOfficialCuaImageRefCredentialText`（凭据令牌 `zcode_cua_frame_ref` 的包含检查，供 unavailable-media 投影与 additionalContext 过滤）、`containsImageRefAuthority`、`parseOfficialCuaImageRef`、`findOfficialCuaFrameContentPair`（image + 紧随引用文本的成对定位）、`attestOfficialCuaFrameContent`（配对存在且引用的 contentProtection 与期望一致才出 attestation）。
- **保留路径**：`preserveOfficialCuaFrameResult` 对官方帧对逐对处理——超限栅格（base64 > `OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES`）经注入的 `imageProcessorPort.prepareForModel` 压缩；请求同时传 `maxBase64Bytes` 与其 3/4 对应的 `maxRawBytes`，满足项目现有 `ImageProcessorPort` 的完整预算契约，并同步改写引用宽高（坐标契约跟随真实栅格）。压缩失败/端口缺失时原样保留（底线是块不丢弃，不是尺寸必然达标）；`_meta` 浅拷贝保留。语义与 core 归一化层一致：`signal` 取消上抛，普通失败按保留原图处理。
- **栅格信封标识**：`readRasterEnvelopeIdentity` 把截图宽高 + PNG mime 映射为确定性 `algorithm` 字符串，进引用文本与 `_meta`，供下游核对坐标契约对应的栅格形状。

## PiP 会话通道（第二阶段实装）

PiP 不复用“一连接一请求”的 broker socket。Host 只在 `pipMode:"enabled"` 时为同一 Helper generation 铸造独立 `pipSocketPath`，并把 `{pipSocketPath, capability, generation}` 只交给 desktop-local `cuaPipSessionService`。路径不是凭据；Unix socket 仍设为 `0600`，所有平台都必须再做 capability 常量时间比较。`pipMode:"disabled"` 时不得生成、传递或清理 PiP socket，`--pip-socket` 必须缺席，`reservedTransport`、启动 handle 与 `waitForTransport` 结果中的可选 `pipSocketPath` 也必须缺席；此时不监听 socket、不接收截图、不启动 presenter。

`pip-session-node.js` 的 `createPipSessionClient` 与 Helper server 使用 node `net` + newline JSON；单帧上限 1 MiB，握手与每个事件都严格校验对象字段、字符串长度和安全整数：

```text
连接后客户端先发 {id,protocol:"zcode.cua/pip-session",version:1,role:"presentation",
                  capability,generation,snapshot:{turns:[turn-started...],focus?}}
服务端回          {id,ok:true,version:1} 或 {id,ok:false,code:"not_authorized"|"version_mismatch"|...}
事件              客户端 {id,kind:"event",event:<PipSessionEvent>}
                  服务端 {id,ok:true,applied:true|false,reason?} / {id,ok:false,code,error}
```

- connection 状态固定为 `AwaitHandshake -> Ready -> Closed`。event-before-handshake、二次握手、坏 UTF-8、超限、多余字段、未知 kind 或认证失败均在接触协调器前拒绝。一个 Helper generation 同时只接受一个已认证 writer；新 writer 完成握手后替换旧 writer，避免两个 Host 同时推进 revision。
- `peerChecker` 只是客户端可选的本地对端加固，不能替代 wire capability，也不得再声称 `remoteAddress` 等于签名身份。`connect`/`send` 并发必须共用同一握手 flight；握手完成前不得发送事件。握手后断连或超帧必须立即销毁 socket 并拒绝全部 pending 请求，不能只等逐请求 timeout。
- `send` 按 id 配对返回 `{applied,reason?}`。客户端对 ACK 同样 fail closed：握手成功帧只接受 `{id,ok:true,version}`，事件成功帧只接受 `{id,ok:true,applied,reason?}`，失败帧只接受 `{id,ok:false,code,error}`；字段缺失、类型错误或多余字段都以 `bad_frame` 销毁连接并拒绝该连接全部 pending 请求。普通断连按有界 `reconnectAttempts`/`reconnectDelayMs` 重连；`version_mismatch`、`not_authorized`、`peer_rejected` 不重试。每次重连的握手携带 service 当前快照，server 原子替换生命周期/焦点状态后才 ACK，解决 Helper 重启和丢连接后的恢复；快照不携带图片。
- services 保存的只是可重放产品事实：每个 session 当前 `turn-started` 与全局最新 `focus-changed`。`turn-ended`/`session-closed` 同步移除快照项。Helper 未启动时只缓存最新有效事实；拿到受管 Host 的完整 tuple 后立即连接。不得仅凭 stable socket 建 PiP，也不得使用未知 capability 的 standalone Helper。

### PiP 状态所有者与时序

Helper 内唯一 `PipSessionCoordinator` 分别维护每 session 的 open turn/最后 sequence/event-id 去重、全局 focus revision，以及每个 open turn 最新的可信 capture。当前真实投递面为 `turn-started`、`turn-ended`、`session-closed`、`focus-changed`；类型中保留的旧 lifecycle kind 只能按同一 turn 匹配规则处理，不得创建第二套状态。

```text
Main focus router ──focus-changed(revision)──┐
Agent turn tracker ──turn lifecycle(seq)─────┼─> Host PiP client ──认证 socket──┐
                                            │                                  │
node_repl ──get_app_state(include_screenshot)─> Helper broker ──可信 capture──┤
                                                                               v
                                                                PipSessionCoordinator
                                                          focus + open turn + capture
                                                                               |
                                                 show/update ──────────────────┤
                                                 hide/dispose <────────────────┘
                                                                               v
                                                              macOS native presenter
```

- lifecycle `sequenceNumber` 按 session 单调，focus `revision` 使用独立全局时钟。小于等于已提交值返回 `applied:false` + `stale-sequence`/`stale-revision`；已见 `eventId` 返回 `duplicate-event`。去重集合、session 数和截图总字节均有硬上限，不得无界增长。Coordinator 对 `sessions` 当前截图与 pending 截图共用 64 MiB 的解码后 PNG 聚合预算（单张仍不得超过 32 MiB）；替换截图先扣除旧值，pending 转入同 turn 的 session 只移动所有权、不重复计数。新截图超过聚合预算时返回 `{accepted:false,reason:"capture-capacity"}`，且不得改变已提交状态或 presenter。
- `turn-started` 打开或替换该 session 的 turn；`turn-ended` 必须匹配当前 open turn，否则返回 `turn-mismatch`；`session-closed` 清除该 session 的 turn/capture，并在它正被 focus 时隐藏。迟到的 tool/terminal/capture 不能复活已终止 turn。
- capture 只能来自 Helper 内成功的 `get_app_state(include_screenshot:true)`，并复核 `context.sessionId + context.turnId`、PNG、frame id 与当前 open turn；PiP wire 客户端没有上传图片或本地路径的能力。capture 早于补发 `turn-started` 时只允许进入 2 秒、有界 pending；匹配 turn 由实时 `turn-started` 或认证重连 snapshot 建立后都必须一次性消费，过期项在匹配前清除。
- 可见条件固定为 `pipMode enabled && focused session 有匹配 open turn && 有可信当前 capture`。失焦、turn/session 终态、截图绑定失效、presenter 崩溃或 Helper shutdown 必须隐藏。`applied:true` 表示协调器状态和必要 presenter 更新已提交；presenter 更新失败不得假 ACK 成功。
- macOS presenter 是同一 Helper.app 内由仓库 Swift 源码构建、可随 bundle 由使用者在外部签名的 accessory/non-activating floating panel；它只从 Helper stdin 接收有界 newline JSON，不监听网络、不接受路径、不激活应用或抢键盘焦点。启动后先输出唯一的 `{type:"ready",version:1}`；其后 `show` / `hide` / `close` 命令必须携带 Helper 生成的有界 `id`，`show.title` 只接受去除首尾空白后非空、无控制字符且不超过 256 UTF-8 bytes 的值，否则 Helper 省略标题。presenter 完成主线程解码及窗口更新后才回 `{id,type:"applied"}`，校验或 AppKit 更新失败则回 `{id,type:"error",error}` 并退出。Node adapter 串行发送且按 id 等待有界 ACK；子进程 `exit` 不能先于 stdout 排空使在途 ACK 误失败，只有 `close` 或协议错误才结算传输终止，stdin 写入成功不能当作窗口已提交。二进制缺失、架构错误、启动失败、坏 ACK 或命令超时使 PiP handshake/当前更新返回 `server_unavailable`，broker 的读屏/输入功能仍可独立工作。
- shutdown 顺序固定为：停止 accept -> 拒绝/收敛在途 PiP 帧 -> hide/close presenter -> 清理 capture/状态 -> 断开 PiP clients -> 关闭并 unlink PiP socket -> dispose producer -> 关闭 broker。重复关闭幂等。

测试必须覆盖握手认证/错版、分片与多帧、并发 connect/send、重连快照、writer 替换、stale/duplicate/turn mismatch、pending capture TTL、可信 capture 绑定、presenter 失败回滚、disabled mode、关闭顺序和 socket 清理；macOS presenter 的协议与打包边界用注入 seam/目录测试覆盖，真机窗口观感按用户要求留给 macOS 验收。

## 决策循环不替换

沿用现有 AgentRuntime 循环与工具准入：`toolAllowlist`/`toolDenylist` 隔离、CommandInbox 串行 admission、owner/lease 路由均不改。缺省模型继续走原生 tool calls；显式 `ui-tars-text-actions` 只增加 provider 归一化后的文本动作 codec，详见 `specs/computer-use-decision-provider.md`，不引入第二套 SDK loop/operator。
