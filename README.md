# LCode 满血版

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="LCode" width="128" height="128" />
</div>

<p align="center">
  <strong>补齐 Git 自动备份功能，支持阿里云 OSS，用户完全掌控。</strong>
</p>

<p align="center">
  基于 <a href="https://github.com/zai-org/ZCode">zai-org/ZCode</a> 的社区增强 Fork
</p>

<div align="center">
  <img src="public/screenshots/git-backup-welcome.png" alt="Git 自动备份引导" width="600" />
  <p><em>首次启动时的 Git 自动备份配置引导</em></p>
</div>

---

## 为什么需要满血版？

LCode 官方开源版本缺少了一项重要功能：**Git 仓库自动备份**。

我们认为，一个优秀的 AI 编程工作台应该具备代码资产保护能力。意外丢失代码是每个开发者的噩梦——磁盘故障、误操作 `git reset --hard`、甚至 AI 误删文件，都可能造成不可挽回的损失。

LCode 满血版补齐了这个缺失的功能。你的 `.git` 仓库会被安全地自动备份到**你自己的**阿里云 OSS 存储桶，使用非对称加密保护，密钥完全由你持有。

## Git 自动备份

### 工作原理

1. **首次启动时引导配置**——主动询问你是否开启自动备份，并引导你填写自己的阿里云 OSS 凭证
2. **扫描 `.git` 目录**——打包 objects、refs、reflog 等完整仓库历史
3. **本地加密**——使用 AES-256-CTR 加密数据，RSA-OAEP 包裹对称密钥，密钥对在你的设备上生成
4. **上传到你的 OSS**——备份文件上传到你自己的阿里云 OSS 存储桶，不经过任何第三方服务器
5. **生成备份清单**——每次备份生成 `repo_backup_manifest`，记录文件清单和哈希校验

### 我们的设计原则

| 设计原则 | LCode 满血版 |
| --- | --- |
| 备份前主动告知用户 | **是**，首次启动明确询问，需要用户主动确认开启 |
| 用户持有全部加密密钥 | **是**，RSA 密钥对在本地生成，私钥从不离开你的设备 |
| 关闭开关真的有效 | **是**，关闭后完全停止，不会静默重启或绕过设置 |
| 备份存储由用户决定 | **是**，上传到你自己的阿里云 OSS，凭证由你配置和管理 |
| 不填写配置即不启用 | **是**，跳过引导后与官方开源版完全一致，无任何额外行为 |

### 如何使用

1. 启动 LCode 满血版，首次运行时会弹出引导对话框
2. 选择"开启自动备份"，填写你的阿里云 OSS 配置：
   - AccessKey ID / Secret
   - Bucket 名称
   - Region（如 `oss-cn-hangzhou`）
3. 完成！后续备份自动进行
4. 也可以选择"暂不开启"，随时在 **设置 → Git 自动备份** 中配置

> 如果你不需要这个功能，跳过即可。满血版不会做任何你不知道的事情。

---

## 更多社区增强功能

### Agent 记忆（工作区记忆）

让 Agent 跨会话记住你的项目约定、偏好与工作上下文：

- 每个工作区独立的持久记忆，以本地明文 Markdown 存储（`MEMORY.md` 索引 + 条目文件），你可以直接查看和编辑
- Agent 在工作中自动读写记忆，新会话开工前自动召回相关上下文，无需每次重复交代
- 首次引导与设置中均可开关（「开启工作区记忆」「会话记忆恢复」），关闭后停止读写

### 动态工作流

把多步骤任务交给 Agent 编排执行：

- Agent 内置 `CreateWorkflow` 工具，可将任务编排为多智能体工作流：子任务 fan-out、循环、条件分支，中间结果带类型流转
- 工作流由多条子代理（actor）通道并行协作；**每条通道可独立指定 AI 供应商与模型**（也可继承会话默认），并可为不同子代理单独配置思考等级与响应速度
- 普通任务同样支持**按任务选择供应商与模型**——不同任务用不同模型，能力与成本按需搭配
- 常用工作流可保存到工作区 `.lcode/workflows/` 并按名重跑；「自动化」面板实时展示运行进度与结果
- 审批边界不变：工作流的敏感步骤仍逐项过权限审批，保存工作流本身也需要确认

### 手机远程控制（镜像桌面）

手机扫码或打开配对链接，获得与桌面完全对等的操作能力（完整客户端镜像，非只读缩略页）：

- **双向授权**：一次性配对 capability + 桌面人工确认，设备凭据本地保存、可随时吊销
- **Cloudflare Worker 隧道**：桌面仅出站连接，Worker 只做鉴权与转发，不保存任务数据；接入 Key 存于桌面凭据库与 Cloudflare Secret
- **断线自愈**：网络闪断后自动刷新重连，60s 宽限免二次确认，会话事实经 replayable 订阅补齐
- 单房间单设备、空闲自动断开；隧道源码见 [cfworker-remote/](cfworker-remote/)

### 自研 Computer Use（桌面自动化运行时）

`packages/lcode-cua` 是我们自研的 Computer Use 运行时。上游官方版本的该功能**未随源码开源**，公开仓库中只保留了基于 nut-js 的简易回退实现；我们以独立 Helper 进程 + xa11y 方案完整自研替代：

- 独立 Helper 进程经能力校验的 broker 执行 14 项 Computer Use 契约动作；权限拒绝即 fail-closed
- 基于 `@crowecawcaw/xa11y` 读取真实 UIA（Windows）/ AX（macOS）/ AT-SPI（Linux）应用树，支持窗口截图、语义操作与原始输入
- 截图以帧三元组（光栅 + 帧引用 + 完整性元数据）输出，携带捕获时的应用/窗口绑定——焦点切换后坐标操作不会误触其他窗口
- CI 为 Linux 提供 xa11y 原生构建（x64 / arm64）

---

## 与官方开源版的关系

本仓库 fork 自 [zai-org/ZCode](https://github.com/zai-org/ZCode)，保持与上游同步。所有新增功能以独立模块形式添加，不修改原有核心逻辑。

```bash
# 同步上游更新
git fetch upstream
git merge upstream/main
```

## 开发指南

与官方版一致，参见下方说明。

### 初始化

准备 Git、Node.js **24.14.0** 和 pnpm **10.33.2**，版本以 [mise.toml](mise.toml) 为准。

```bash
pnpm bootstrap
```

| 入口 | 用途 | 开发命令 |
| --- | --- | --- |
| Desktop | Electron 桌面应用 | `pnpm dev:desktop` |
| Web / LCode 命令行版 | 终端与浏览器工作台 | `pnpm dev:web` |
| Agent CLI | 终端 Agent 运行时 | `pnpm --filter @lcode/cli dev` |

详细的开发、配置、打包说明请参考 [官方 README](https://github.com/zai-org/ZCode/blob/main/README.md)。

## 仓库结构

| 目录 | 职责 |
| --- | --- |
| `packages/desktop` | Electron Main、Host、Renderer 与桌面打包 |
| `packages/web` | Web 客户端 |
| `packages/server` | HTTP / WebSocket 服务与远程连接 |
| `packages/ui` | 共享 React 组件、hooks 与 Zustand 状态 |
| `packages/services` | 业务服务与持久化 |
| `packages/services/src/git-backup` | **Git 自动备份服务（满血版新增）** |
| `packages/lcode-cua` | **自研 Computer Use 运行时（满血版新增）** |
| `cfworker-remote/` | **手机远程控制 Cloudflare Worker 隧道（满血版新增，独立仓库）** |
| `packages/shared` | 共享协议和类型 |
| `apps/lcode-cli` | Agent CLI、TUI、运行时与工具 |

## 背景

2026 年 9 月，安全研究人员发现 LCode 桌面版存在[静默上传用户工作区 `.git` 完整历史](https://blog.ferstar.org/posts/zcode-silent-workspace-snapshot-upload/)的行为，相关讨论见 [zai-org/feedback#707](https://github.com/zai-org/feedback/issues/707)、[#709](https://github.com/zai-org/feedback/issues/709)、[#711](https://github.com/zai-org/feedback/issues/711)、[#715](https://github.com/zai-org/feedback/issues/715)。

随后 Z.ai 将 ZCode 客户端开源，但[上传相关代码在开源前被完全剥离](https://github.com/zai-org/ZCode/issues/9)。

本项目认为 Git 仓库备份本身是有价值的功能——前提是用户知情、用户掌控、用户可关闭。因此我们将这个功能以透明、安全的方式重新实现。

## 许可

本项目继承上游 [Apache License 2.0](LICENSE)。

## GitHub Actions 桌面发布

推送 `main` 后，Actions 为 macOS、Windows、Linux 分别构建 x64 与 arm64 包。
先把根目录 `package.json` 的 `version` 更新为发行版本，重新运行
`node scripts/licenses.mjs notices`，提交版本与许可证清单，再推送对应的
`v<version>` tag（例如 `v3.14.2`）。tag 与版本不一致时构建直接失败；六个平台全部成功后，
Actions 才会将安装包上传到同名 GitHub Release 草稿；严格第三方许可校验通过后才公开发布。
macOS 包未经 Apple 签名和公证。

## 项目声明

功能与优惠范围、维护规则、执行与数据风险，以及许可和第三方版权说明，详见 [NOTICE.md](NOTICE.md)。
