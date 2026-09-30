# Git 自动备份

## 目标与范围

修复「设置 / 数据与统计 / Git 自动备份」的占位逻辑。设置、首次引导、手动备份与自动调度使用同一 Host 服务契约，不以浏览器存储或 UI 定时器作为已保存事实源。OSS 请求直达用户配置的阿里云存储桶，不经过产品服务器。

备份覆盖 `.git` 仓库数据，包括 objects、refs、reflog，不备份工作区未提交文件。保留 `repo_backup_manifest/v1` 的长度编码归档格式与 AES-256-CTR / RSA-OAEP-SHA256 解密兼容性。不能完整覆盖的 linked worktree、gitfile、外部 alternates、依赖 promisor remote 的 partial clone 或外部 include 配置等仓库必须明确报错，不能声称已备份。

## 状态与边界

- `GitBackupService` 是对应文件系统 Environment 的配置、密钥、已加入工作区、调度时间及成功/失败记录的唯一所有者；Desktop Main 仅转发 RPC，不持有备份业务状态。
- 配置使用 Host profile 数据目录。OSS Secret 使用 Host CredentialService，不再写入 localStorage 或配置 JSON；配置文件持久化必须异步、原子且限制权限。getConfig 返回空 secret，保存时空值复用同一 AccessKey ID 的已保存 secret。修改 ID 必须重新输入 secret。禁止凭据日志。
- 自动备份工作区由用户显式加入，按 `workspaceIdentity?.trim() || workspacePath` 去重。identity 用于绑定、对象命名与关联，path 用于文件操作；不能因为同路径而把远程工作区路由到本机。
- 一个 profile 的所有 Host 共享持久化调度状态，并使用跨进程互斥避免同一周期、配置或密钥并发写入。配置、调度与引导完成记录在同一原子文档提交；凭据写入新的不可变引用后才提交文档，提交失败不覆盖旧凭据、不启用计划。凭据引用保存在 profile 文档中，不依赖当前绝对路径，数据目录迁移后保持可读取。旧分文件记录在持锁读取时一次性导入。进程关闭释放调度资源，不调用会改变用户 enabled 设置的 stopBackup。
- UI 只保留未提交草稿、请求中状态与服务状态投影。通过 `packages/ui/src/hooks/` 获取当前工作区 Host；引导与设置均传递完整 path、identity、remoteSessionId、remoteTarget，包含设置覆盖工作区与仅有 remoteTarget 的恢复阶段。断连保持不可用，绝不降级到本机备份。
- 手机 Web attachment 访问桌面已有 Host 的同一服务；不另启 Agent 或 Local Host。桌面连续链路与手机可恢复链路均使用 RPC 读取持久化状态，重连后重新读取，无 UI 自建备份队列。

```mermaid
sequenceDiagram
  participant UI as 设置或首次引导
  participant Route as 工作区服务路由
  participant Host as GitBackupService
  participant Store as Profile 持久化与互斥
  participant OSS as 用户 OSS
  UI->>Route: 校验后提交配置与目标 identity/path
  Route->>Host: configure
  Host->>Store: 加密凭据写入新引用
  Host->>Store: 同一文档原子提交配置、调度、引导记录
  Host-->>UI: 成功后刷新配置与状态
  Host->>Store: 到期读取配置并申请唯一执行权
  Host->>Host: 读取完整快照、清单、加密
  Host->>OSS: 数据与密钥材料上传
  Host->>OSS: 全部成功后最后写入清单
  Host->>Store: 持久化结果与下一次执行时间
  UI->>Host: 读取状态，重连后重新读取
```

## 产品规则

1. 默认关闭；首次引导加载服务完成记录后才显示。跳过只持久化完成记录，不启用。开启必须以 `configure` 的完成引导选项在一次 Host 提交中保存有效配置、显式目标及完成记录，任何提交失败都不能留下已启用计划；失败保留表单并显示错误。
2. 设置读入已保存配置。OSS 与间隔修改使用明确保存动作；未保存表单不会被状态刷新覆盖。启用开关保存成功后才更新，不允许缺少有效配置或工作区时开启。
3. 间隔必须为 5 到 1440 的整数分钟。校验 AccessKey、bucket、region 和对象前缀，支持 `cn-hangzhou` 与 `oss-cn-hangzhou`，不接受自定义 URL、路径穿越或非法 bucket。
4. 自动备份只处理已加入列表。保存当前工作区或开启会幂等加入；可以移除目标。关闭不会丢失配置、密钥或已加入列表；不会新增上传，已开始的运行允许完成，页面准确说明。
5. “测试连接”使用用户表单配置执行真实的非写入 OSS 请求，不上传测试对象。空 secret 仅复用同一 AccessKey ID 的已保存 secret。不伪造成功；修改表单清除旧结果；测试过程禁用重复点击，完整显示失败详情。
6. 手动备份使用已保存配置和当前工作区，允许自动调度关闭时运行。不自动保存未确认的草稿。无工作区、断连、配置无效或已运行时禁用；完成显示结果，失败显示原因。
7. 状态显示运行中、上次成功时间、文件数、大小、下一次调度及错误。没有成功记录时不能显示成功。刷新不覆盖编辑草稿；晚到结果不污染新 Host / 新工作区。
8. 公钥可查看；私钥仅在明确导出操作后通过 `IPlatformService.saveFile` 保存，不在页面、剪贴板或日志中展示。取消导出不报成功，失败必须显示错误。密钥首次生成并发安全，残缺或损坏时不得重生成覆盖旧私钥。
   Web 的 saveFile 仅接受字节数据并启动浏览器下载，不返回原生绝对路径，也不能观察下载后的系统取消或落盘结果。拒绝 sourceUrl 请求且不发起网络访问。页面对 Web 显示“已开始下载”，对 Desktop 显示原生保存结果。新增此可选能力不能改变现有图片下载的 Web fallback。
9. OSS URL 使用 bucket 子域且签名资源与编码路径一致。HTTP 非 2xx、断网和超时均使备份失败。清单最后上传作为完成标记；不同工作区和并发尝试使用不同对象前缀，不能互相覆盖。
10. 清单哈希与归档必须来源于同一组读取字节，并检测扫描期间文件改变，不能将不一致快照报告为成功。单次归档最多 256 MiB、100,000 个文件；不跟随符号链接把仓库外数据意外上传。清单 v1 含文件名、哈希及工作区路径等元数据，只有仓库文件内容加密，页面与文档准确披露。
11. 保留 v1 格式不等于增加恢复或认证能力。AES-CTR 不提供认证防篡改，明文清单中的 SHA-256 不能作为可信认证证明；归档不记录文件权限，恢复时无法可靠还原 hook 等文件的执行权限。当前没有内置恢复命令，格式解析与解密单测不构成产品级恢复验收。

## 迁移

旧浏览器 `git-backup-config` 从未形成真实服务配置，不能因迁移自动开启或产生上传。首次读取仅转为待确认草稿；显式保存成功后清除旧凭据。旧 onboarding 标记可迁移为服务完成记录，失败不删除旧记录。Host 保存成功后，浏览器禁止删除旧数据不能将已提交结果误报失败；保留旧数据供以后清理。引导读取失败重试成功时，表单必须从新读入的配置初始化；保存失败时保留已填写草稿。旧 Host 缺少 channel 时页面显示不可用，不显示假成功。RPC 中新增方法无需改变 Agent stdio 协议。

## OSS / MinIO 多目的地扩展（2026-09-30）

### 范围与唯一所有者

- 在现有 Host 服务中增加 MinIO；每个 profile 提供 OSS、MinIO 两个独立配置槽，不增加 UI 上传器、另一个调度器或任意数量的同类账户。
- 总开关 `enabled` 控制自动调度；`destinationEnabled` 分别选择 OSS / MinIO，两者可以同时启用或只启用一个。保存配置不自动选择新目的地、不自动开启总开关。开启总开关要求至少一个选中的有效目的地及已加入工作区。
- 保留共享间隔、工作区列表和加密密钥。每个目的地的凭据、可用性、上次尝试、上次成功和错误分别持久化；配置位置或账户改变后清除该目的地旧位置的成功投影。
- 设置提供存储类型选择器、各目的地开关、独立编辑草稿、测试和当前目的地手动备份，以及“备份到所有已启用目的地”。切换类型不丢失另一目的地未保存草稿，测试结果按类型和草稿版本隔离。
- 首次引导继续兼容原 OSS 表单，原子保存 OSS 与引导完成，不覆盖 MinIO 配置或启用状态。旧浏览器 OSS 草稿仅在 OSS 明确保存后清理；保存 MinIO 不清理。

### 请求与凭据

- MinIO 使用维护中的 AWS Signature V4 签名器，S3 path-style 请求；endpoint 为用户提供的 S3 API origin（不是控制台地址），允许 HTTPS 和明确填写的 HTTP，不允许 userinfo、query、fragment 或路径。HTTP 会暴露传输内容，页面明确警告，不禁用 TLS 校验。
- MinIO region 默认 `us-east-1`；bucket、endpoint、账户、region 和前缀按 MinIO 规则校验，不复用 OSS region 规则。
- MinIO HEAD bucket 测试不创建对象、不创建 bucket；HEAD 成功不证明 PUT 权限。上传使用同一 Host 注入的网络适配器，保持代理、No Proxy、自定义 CA、超时和禁止重定向，不从浏览器直连。
- OSS 和 MinIO 凭据引用隔离。空 Secret 只能复用同一目的地与 AccessKey ID 的凭据；MinIO endpoint 改变也要求重新填写 Secret，避免把旧密钥发给新服务器。getConfig 始终清空所有 Secret，错误和日志不得输出签名或凭据。
- 所有目的地配置、引用、状态与引导仍在一个锁和一个原子文档提交。新密钥先写不可变引用，文档失败清理新引用而保留已接受配置和旧引用。

### 运行顺序与失败

```mermaid
sequenceDiagram
  participant UI as 设置 / 手机 attachment
  participant Host as 同一 GitBackupService
  participant Store as Profile 文档与执行锁
  participant OSS as 阿里云 OSS
  participant MinIO as MinIO S3 API
  UI->>Host: configure(目的地配置 / 独立开关)
  Host->>Store: 新凭据引用后原子提交
  Host-->>UI: 已接受状态
  Host->>Store: 手动或到期 admission，冻结选中配置及凭据
  Host->>Host: 捕获一次完整仓库快照并加密一次
  par OSS 已选中
    Host->>OSS: payload settled 后提交 manifest
  and MinIO 已选中
    Host->>MinIO: payload settled 后提交 manifest
  end
  Host->>Store: 所有目的地 settled 后记录独立结果与总结果
  Host->>Store: 更新下一次调度，释放执行锁
  UI->>Host: 重连 / 刷新读取权威状态
```

- 手动默认备份到所有 `destinationEnabled` 的目的地，不受总自动开关限制；可明确指定一个已保存目的地，即使其自动开关关闭。无选中目的地的默认手动操作明确报错。
- 每个工作区 admission 时冻结配置及凭据；运行期间关闭某目的地或总开关不取消已经接受的运行，下一工作区 admission 重新读取配置。删除工作区等既有规则不变。
- 同一工作区只捕获 / 加密一次，OSS 与 MinIO 使用同一相对 backup ID，各自前缀独立。一个目的地失败不阻止其他目的地完成；每个目的地只有三个 payload 都成功后才上传自己的 manifest。
- 等待所有目的地及其 payload settled 后才能释放执行锁。全部选中目的地成功才返回总体成功；部分失败明确拒绝并携带不含凭据的目的地结果，同时持久化成功目的地的记录。失败目的地不写完成清单，不回滚成功目的地、不删除远端对象、不增加自动重试队列。
- 全局上次成功只表示某次选择的目的地全部成功；目的地面板分别显示成功与失败，不能以一方成功掩盖另一方失败。多工作区周期错误不能被后来成功覆盖。
- 桌面 `desktop-continuous` 与手机 `web-remote-replayable` 均沿用现有 RPC 和同一持久化所有者；不增加 Agent stdio 协议、手机运行时或恢复队列。

### 迁移和验收

- 旧仅 OSS 文档 / `_backup.version: 1` 在既有文件锁内一次性迁移到版本 2。保留原总开关、间隔、到期时间、工作区、引导完成及精确 OSS credentialReference，不重新按路径计算；旧已保存 OSS 默认被选中，MinIO 默认关闭。
- 历史成功只归入 OSS，不伪造 MinIO 成功。迁移后移动 profile 仍使用已保存引用。旧 RPC 客户端的 OSS configure/test/start 调用保留兼容默认语义。
- 测试覆盖：旧文档迁移 / 重启、独立凭据和失败回滚、OSS-only / MinIO-only / 两者、任一失败仍完成另一方、慢请求 settled 后释放锁、各自 manifest-last、无目标拒绝、停止与多 Host 去重、endpoint 改变不复用 Secret。
- MinIO 测试覆盖 SigV4 已知向量 / 独立签名确认、bucket HEAD、路径编码、端口、HTTP/HTTPS、失败 / 超时 / 重定向，不使用真实服务器或用户凭据。
- 页面交互覆盖类型切换草稿保留、独立开关失败、保存 MinIO 不覆盖 OSS、单个与全部手动备份、部分失败状态、断连防本地 fallback、手机无溢出。实际执行现有测试、类型 / Lint / 架构检查与 Web 构建，诚实记录未使用真实 OSS / MinIO 或原生桌面对话框。

## 验收与测试

- 服务单测：默认关闭、有效保存与重启恢复、非法间隔/配置拒绝、目标 identity 去重、配置并发合并、禁用保留数据、到期调度与多实例去重、dispose 不改变 enabled。
- 备份单测：无仓库、gitfile/alternates/符号链接错误；归档解码并解密校验；清单与字节一致；上传失败不写成功状态；清单最后提交；对象路径隔离；密钥并发及残缺保护。
- OSS 单测：正确 bucket endpoint、region 标准化、路径编码、签名、真实连接检测、HTTP 错误及请求超时，全部使用模拟网络，无真实凭据或上传。
- UI 单测与交互验收：加载失败重试、保存并重新打开、测试结果随编辑失效、错误消息有详情、开关失败回滚、当前工作区手动备份、私钥取消/失败、首次引导保存失败、晚到请求和断连防误路由。
- 页面 E2E 场景：桌面宽度及手机宽度下保存、测试、开关、手动备份与公钥展示可操作，表单标签可访问，长路径与错误不溢出；Web/手机断连状态无本机 fallback。网络可用测试桩，不触碰用户 OSS。
- 实际执行目标测试、`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`，分别报告结果和未覆盖范围。
