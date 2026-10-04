# Git 提交弹窗发布增强：多远程、分支与 Tag

状态：2026-10-01 已实施并完成源码、临时 Git 仓库及浏览器夹具验收；未构建、安装或执行真实远程发布。完整验证结果及限制见文末。

关联：[任务完成后自动生成提交信息](git-auto-commit-message.md)、[多会话提交审核](git-session-commit-review.md)。

## 背景与现状

2026-10-01 调查确认（L-GO）：

- 任务完成后的自动提交信息、输入框旁“生成提交纪要”、普通 Git 操作入口共用同一个 `GitActionMenu` 弹框；自动流程只预填草稿并打开窗口，不自动提交或推送。
- 弹框已具备：提交信息编辑与重新生成、包含未暂存修改、按会话分组的冻结审核与人工确认、提交 / 提交并推送 / 推送。
- `IGitService.push` 只接收工作区，不能显式指定 remote、目标分支或 Tag；已有上游时执行裸 `git push`，实际目标由 Git 配置决定。
- Tag 目前只在 Git 图谱中展示；没有列举、创建或推送 Tag 的业务接口。
- 仓库自身的发布约定（`v${version}` Tag、版本文件一致性、release-it）属于本项目发布链，不是本功能的通用规则。

本轮目标：在提交审核弹框中提供远端与 Tag 发布，覆盖多远程推送、分支目标选择、Tag 创建与推送、执行摘要、分步结果与重试、草稿保留、消息辅助、审核界面增强与发布预设。2026-10-03 的工作树增强统一入口文案：本地为“提交审核”，工作树为“提交与合并审核”；发布区域显示实际发布分支，来源工作树分支与合并后的项目目标分支分别操作，具体规则见 `worktree-ui.md`。

## 产品行为

### 发布选项区

- 默认收起，不改变现状：默认键盘动作仍是“提交”；任何发布动作必须显式勾选并确认。
- 组合式设计：远端多选 + 是否推送分支 + Tag 处理方式。可组合出“仅提交”“提交并推送多个远端”“提交并发布新 Tag”“仅创建 Tag”“仅推送已有 Tag”“推送分支并推送 Tag”等全部场景，不引入互相排斥的模式枚举。
- 发布区与执行结果都留在提交弹框内；不新建第二个提交窗口。

### 多远程仓库

- 一次本地提交，推送多个远端；绝不为每个远端重复创建提交。
- 每个远端默认推送当前分支的同名分支，可改成其它目标分支名。
- 顺序执行；单个远端失败不影响其它远端；只重试失败项。
- 绝不使用 force；服务器拒绝（非快进、权限、保护分支）以明确原因逐项展示。
- 上游设置以**本地分支**为单位，不能表述为“每个远端的上游”。已有 `branch.<name>.remote/merge`（含继承配置、部分配置或多个值）一律保留。本地分支完全没有上游时，本轮第一个成功推送到同名目标分支的远端可安全设置唯一上游；后续远端及失败项重试均不得改写。推送到异名分支或仅推送 Tag 不设置上游。

### Tag

- 处理方式四态：不处理 / 仅创建 / 创建并推送 / 仅推送已有（可选择一个或多个本地 Tag）。
- 建议名称：从本地既有 Tag 中识别 `v?主.次.修订` 形式取最高者，提供 patch / minor / major 递增建议；无法识别时要求手动输入。支持自定义名称，并在本地做名称合法性校验。
- 多个远端使用同一 Tag 名称与同一目标提交；目标提交是执行时的最终 HEAD（本轮全部审核分组提交完成之后）。
- 已存在的 Tag 一律不覆盖、不移动、不删除。本地冲突阻止创建；远端冲突由推送明确报错。
- 默认创建轻量 Tag；annotated / 签名 Tag 留待后续。
- 创建本地 Tag 不修改版本文件，也不直接执行远端流程；推送 Tag 可能按远端仓库规则触发构建、部署或发布流水线，界面不能保证“不触发发布流水线”。

### 执行前摘要与冻结

- 确认前展示：将提交的文件与分组数、源分支、每个远端及其目标分支、Tag 名称与目标提交、哪些步骤纯本地、哪些会发布到远端。
- 确认后冻结执行目标（提交结果、分支名、Tag 名与目标提交）。执行期间 HEAD、分支或工作区发生外部变化即中止剩余步骤，要求重新确认。

### 分步结果与失败重试

- 每个远端分别展示分支推送与 Tag 推送结果；失败项可单点重试。
- 重试不得重新提交、不得重新创建 Tag、不得强推。

### 消息草稿与编辑辅助

- 关闭弹框保留用户编辑的提交消息；重新打开恢复；提交成功后清除。
- 切换“包含未暂存修改”等选项只失效审核，不再丢弃用户输入。
- 主题行长度提示（第一个空行之前，参考上限 72）；常用 Conventional 类型快捷插入；复制消息；重新生成后可恢复上一版文本。

### 审核界面增强

- 分组导航（上一组 / 下一组）、文件列表全展开 / 收起、警告与合并原因置顶展示。
- 按文件排除审核范围：任何排除或恢复都必须重新生成审核，禁止沿用旧冻结结果提交。

### 发布预设

- 发布预设为默认收起的独立折叠区，不阻挡发布主动作；保存、应用与删除规则不变。
- 每个 workspace 可保存 / 应用 / 删除命名预设（远端组合、目标分支、Tag 方式与递增策略）。
- 预设是 UI 本地便利数据（localStorage，按 workspace identity 隔离），不进协议、不进快照、不跨设备同步；应用预设只填充选项，仍必须确认后才执行。

### 自动流程不变

- 任务完成后的自动行为仍只预填提交信息并打开弹窗；不自动提交、推送、创建或推送 Tag。

## 状态所有者与边界

| 状态 / 事实                              | 唯一所有者                               | 说明                                                          |
| ---------------------------------------- | ---------------------------------------- | ------------------------------------------------------------- |
| 消息草稿、范围和审核阶段                 | 目标 Host 的 GitReviewWorkspaceState     | 跨端版本化快照；UI 仅投影与保留未接受编辑                     |
| 弹框选项、确认、执行计划、结果与重试状态 | `GitActionMenu`（当前端）                | 关闭只隐藏并保留同一控制器；跨 scope 失效                     |
| 远端列表、Tag 列表、创建 Tag、推送       | 目标 Environment 的 `IGitService`        | Desktop、本地 Web 与远程 workspace 均通过注入的 Host 服务执行 |
| 审核冻结与提交事实                       | 目标 `IGitService` / CommitReviewService | 沿用既有分组、顺序与幂等规则                                  |
| 发布预设                                 | UI 本地 localStorage（按 identity key）  | 便利数据，不是服务端事实，不参与同步                          |
| 执行期冻结目标                           | `GitActionMenu` 本次执行                 | 不写入会话快照                                                |
| 自动草稿                                 | 沿用 `SessionPane` / `GitActionMenu`     | 行为不变：只预填消息并打开弹窗                                |

## 事件顺序

```text
用户展开发布选项 -> 读取 listRemotes / listTags（目标 Host）
用户确认 -> 冻结执行目标（提交结果、分支名、Tag 名与目标提交）
        -> [需要提交] 既有审核分组提交（顺序与幂等规则不变）
        -> 对每个远端顺序执行：
             推送分支 -> 结果 A
        -> Tag：仅创建（一次，本地）/ 创建并推送 / 仅推送已有
             推送 Tag -> 每个远端一份结果 B
        -> 汇总分步结果；失败项可单点重试（不重复提交、不重复创建）
```

## 幂等、隔离与失效

- 隔离键沿用 `workspaceIdentity?.trim() || workspacePath` 与远程 session 语义；新增服务方法同规。
- Tag 创建幂等：已存在且指向同一提交视为已创建；指向不同提交直接报错。
- 推送重试幂等：相同引用重复推送为 no-op 或被服务器拒绝并如实展示。
- 外部 HEAD / 分支变化使冻结目标失效：中止剩余步骤并要求重新确认。
- 弹窗隐藏后原请求继续结算，不能重新打开或重复执行。切换 workspace/会话或控制器销毁后，旧请求结果不得写回新 scope。

## 失败语义

- 任一远端失败不阻塞其它远端；失败原因逐项展示并可重试。
- Git 或服务错误不改变任务完成事实；不自动回滚已成功的提交、推送或 Tag。
- Tag 名称非法、本地冲突、远端冲突：给出明确原因，禁止静默跳过或覆盖。

## 验收场景

1. 一次提交推送到多个远端：每个远端独立结果；其中一个失败时其余照常成功，重试只重发失败项。
2. 仅创建 Tag：本地出现该 Tag，无网络推送；重复执行提示已存在且指向同一提交（幂等）。
3. 创建并推送 Tag 且推送分支：远端分支与 Tag 均更新；Tag 指向最终提交。
4. 仅推送已有 Tag：不产生新提交、不创建新 Tag。
5. 建议版本：已有 v1.2.3 时提供 v1.2.4 / v1.3.0 / v2.0.0 建议；自定义与非法名称路径正确。
6. 远端已有同名但指向不同提交的 Tag：推送被拒绝并展示原因，不覆盖。
7. 执行前摘要展示全部目标与本地 / 远端步骤；默认键盘动作仍是“提交”。
8. 执行中外部提交改变 HEAD：中止并提示重新确认，不把 Tag 落到错误提交。
9. 关闭弹窗后重新打开：消息草稿、冻结审核、发布预览与执行结果保留；不重复生成或执行。结果可返回只读预览；显式返回编辑会取消尚未执行的预览，已执行结果不会回退。
10. 按文件排除后必须重新审核，旧冻结结果不可提交。
11. 预设：保存 / 应用 / 删除；按 workspace 隔离；应用后仍需确认。
12. 自动草稿回归：任务完成仍只预填并打开弹窗，不自动发布。
13. 桌面与 390px 移动端、浅色 / 深色主题下发布区可用且无横向溢出。
14. 本地或来源工作树当前所选范围没有待提交文件时，明确提示可预览发布现有提交，“预览提交并发布”不可用但单独发布不要求新建提交。排除全部文件也显示“所选范围”为空，不能误报整个仓库已干净。远端目标分支字段与实际来源发布分支区分，长目标名称可完整阅读；预设默认折叠，展开后原功能不变。
15. 合并结果有带目标分支名的独立发布入口，Tag 和推送冻结在原项目目标 HEAD，不能把来源任务分支 HEAD 作为已合并结果发布。阶段切换仅走现有 Host 共享 mergeView，不新增第二份业务状态。具体时序与验收见 worktree-ui.md。

## 接口方向（供冻结）

- `packages/shared/src/git.ts`：
  - `GitRemoteInfo { name; url }`、`GitRemoteListResult { remotes }`；
  - `GitTagInfo { name; commitHash }`、`GitTagListResult { tags }`；
  - `GitCreateTagRequest { workspacePath; workspaceIdentity?; name; ref? }`、`GitCreateTagResult { name; commitHash; created }`；
  - `GitPushRequest` 扩展可选 `remote? / branch? / tag?`；缺省保持现有行为；
  - 以上全部补 zod 运行时校验（沿用现有 schema 模式）。
- `packages/services/src/git/git.ts`（`IGitService`）：新增 `listRemotes`、`listTags`、`createTag`；`push` 支持显式目标。
- UI：`packages/ui/src/git-action-menu/` 新增纯逻辑与组件文件；`GitActionMenu.tsx` 仍是唯一弹窗所有者。

### 实施契约补充（2026-10-01）

- 新增 `IGitService.getPublishState(GitRepositoryRequest)`，返回 `GitPublishState { headCommitHash: string | null; branchName: string | null; indexFingerprint: string; worktreeFingerprint: string }`。由目标 Host 读取实际 HEAD、symbolic ref、index 与整个 checkout 的 Git 工作树内容（全部 tracked 与未忽略的 untracked，包含空文件和符号链接，不含 Git 元数据与忽略的构建/依赖目录）；不依赖 UI 行数或缓存摘要。读取失败、冲突或无法完整捕获时明确拒绝，不能把未知状态当作一致。
- `GitRepositoryRequest` 增加可选 `workspaceIdentity`。`GitPushRequest` 与 `GitCreateTagRequest` 增加可选 `expectedState`；显式推送 Tag 可带 `tagCommitHash` 校验冻结目标。显式分支推送使用冻结提交哈希到 `refs/heads/<branch>` 的完整 refspec；显式 Tag 推送仅传所选 `refs/tags/<name>`。禁止由 `push.default`、mirror 或 followTags 扩大发布范围。旧的无显式目标 push 继续兼容。
- `GitCommitRequest` 增加可选 `expectedState`，本轮带发布确认的提交先验证整仓状态，再走既有提交路径。`GitCommitResult` 可返回 `publishState` 供后续步骤使用；本次合法提交只允许改变 HEAD/index，工作树内容必须保持一致。Hook 警告或外部变化后停止发布，保留已成功提交事实。
- 普通手动提交与发布确认提交的选中文件捕获统一由 Host `commit(paths, stagedOnly)` 执行；包含未暂存时在临时 index 捕获所选新建/修改/删除/重命名，提交后仅同步相关真实 index 路径，保留其它文件暂存内容。UI 不再单独 stage；审核路径仍不改变其冻结树/CAS 实现。普通提交不强制整仓发布快照，避免有界发布捕获影响旧手动入口。
- `createTag` 仅允许最终 HEAD 作为目标；省略 ref 时解析 HEAD，指定 ref 时必须精确等于当前 HEAD 的完整哈希。创建使用不覆盖的 Git 原子引用操作；并发同名同提交为幂等成功，不同提交明确冲突。
- 文件排除通过 `GitGenerateCommitMessageRequest.excludedFilePaths?: string[]` 传入目标 Git 服务，在捕获审核前按同一 repo 路径规则过滤。空范围不能回退为全仓范围；审核、普通手动提交与摘要共用排除后的文件集合。
- 本轮不新增服务端执行队列：UI 在确认后保存不可变执行计划，每一步将 Host 返回的版本作为下一步前置条件。每个远端失败继续其它远端，但任何版本变化终止所有剩余步骤；失败项重试复用原版本与原提交，不重新提交或创建 Tag。
- 远端列表展示有效 push URL；同一 remote 配有多个 push URL 时显式发布拒绝，避免一个已勾选远端暗中发布到多个目的地。每次推送在执行前后核对该步的有效 push URL；本轮冻结契约不新增 remote 配置版本，不声称可以原子锁住用户外部 Git 配置写入。
- 消息草稿、上一版、排除范围、分组及来源/合并阶段依照 [跨端审核编辑状态](git-review-cross-platform-state.md) 由目标 Host 持久化与同步，按 identity 和会话隔离。X/遮罩规则与差异返回遵循工作树界面 spec；关闭只隐藏，保留本端冻结审核、确认项、计划与结果。人工确认和发布执行器不随草稿同步，避免另一设备代替用户确认；预设继续按 identity 存于当前设备 localStorage。
- 消息复制通过 `IPlatformService.writeClipboardText?(text)` 与现有 platform hook；Desktop renderer/Web 适配器写入当前设备的剪贴板，手机不转发到 Git Host。能力缺失或权限拒绝明确失败，不记录消息正文，不新增 IPC/协议。
- 显式 push 必须同时提供 remote 与 branch/tag 之一。`GitPushResult.warning?` 表示推送已经成功但后置状态校验/上游设置需人工检查；UI 保留成功事实并停止剩余发布，不能把它当成可再次提交的失败。审核分组仍逐组确认、按既有游标提交；只有最后未提交组允许“提交并发布”，或用户明确选择“不提交，只发布当前 HEAD”。

```text
GitActionMenu（本端执行计划 owner；共享草稿由目标 Host 所有）
  用户检查摘要 → Host getPublishState → 用户显式确认
  → [有提交] Host 校验 expectedState → 原审核/提交 → 已提交事实 + 下一版本
  → Host 校验同一版本 → 显式分支推送（逐远端）
  → Host 校验同一版本 → 本地 Tag 创建一次 → 显式 Tag 推送（逐 Tag/远端）
  → 原版本下仅重试失败推送；版本变化终止，scope 切换使旧响应失效
Desktop continuous ─┐
Web replayable ─────┴─ 同一目标 Host 服务；审核编辑状态以独立 RPC 快照和订阅恢复，执行事实继续沿原受校验命令
```

### 三项补丁契约（2026-10-01）

- Tag 创建结果的 `created` 事实继续由 Host 返回；UI 执行结果保存该布尔值，不根据 Tag 列表推测。`created: true` 显示“已新建本地 Tag”，`false` 显示“Tag 已存在且指向同一提交”，两者均为成功，均展示目标提交；不新增重复创建或重试步骤。
- 显式 push 失败需同时保留 Git `--porcelain` stdout 的逐引用拒绝原因与 stderr 的远端/权限诊断，超时和输出超限等状态也必须保留。错误仅补充展示信息，不把失败改成成功、不绕过冻结状态校验、不扩大推送或重试范围；普通 Git 命令的公共错误转换不受影响。
- Tag 列表继续以可解析为 commit 的轻量/annotated Tag 作为可发布选项。已 peel 为 tree/blob 的合法 Tag 不阻断列表，返回可选 `GitTagListResult.unsupportedTags: { name; objectType: "tree" | "blob" }[]`，UI 明确列出其名称、类型及“非提交目标，不支持发布”，不参与版本建议或选中集合。`tags` 既有结构与 `commitHash` 保持不变；旧 Host 缺该可选字段等价于无提示。
- 只将确定为 tree/blob 的对象视为不支持，不吞掉对象损坏、命令失败、输出截断、Tag 在查询中消失等错误。直接创建同名特殊 Tag 明确报冲突，直接推送特殊 Tag 明确拒绝且无远端副作用；不伪造 commitHash、不移动或删除原引用。
- 所有者与时序不变：Host Git 结果 → 当前弹框代次校验 → 本地结果/目录展示；Desktop continuous 与 Web replayable 共用同一服务契约，补丁不增加持久状态、队列或自动发布入口。

补丁验收：重复创建返回明确幂等提示且仍允许后续所选 Tag 推送；真实非快进/远端拒绝及注入双通道错误展示完整原因；commit、轻量/annotated tree/blob Tag 混合时可列举/推送正常 Tag，并明确提示特殊 Tag；损坏/失效对象仍报错。测试只操作临时仓库与浏览器桩 Host。

## 本轮不做

- Release notes / CHANGELOG 生成、版本文件升级、GitHub / GitLab Release、CI 状态查询。
- remote 的新增、编辑与删除。
- annotated / 签名 Tag；Tag 删除与移动；任意提交作为 Tag 目标。
- 预设跨设备同步；发布结果的持久通知。

## 验证方式

- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。
- 定向 node:test：shared 契约、services Git（含 os.tmpdir 临时仓库）、UI 纯逻辑与既有 git-action-menu 回归。
- 既有 Web 夹具浏览器回归；服务集成测试只在 `os.tmpdir` 的隔离工作区与本地 bare remotes 创建提交、Tag 和推送，不调用真实模型或远程服务。真实远程发布与安装版交互由用户自行验证，自动化测试绝不操作用户仓库的提交、Tag 或远端。
- 发布确认的普通手动提交沿用原生 `git commit`，执行前后校验版本并在发现变化时停止后续发布；不宣称替代审核路径的冻结树/CAS 原子提交保证。原审核路径继续保留冻结补丁、人工确认与分组幂等。

## 实施与验收记录（2026-10-01，Windows）

### 已落地

- 单一 `GitActionMenu` 控制器保留所有入口，弹窗组件拆入 `git-action-menu/`。默认收起发布区，键盘动作始终仅提交；远端/分支/Tag 组合、同窗摘要与确认、分步结果、失败推送重试、草稿、消息辅助、分组浏览/排除与预设已接通。干净且已同步仓库在桌面与手机 mini 状态面板也能打开此入口。
- shared 公开严格 schema，services 负责完整内容快照、精确 OID/refspec、轻量 Tag 原子创建及上游配置。既有 annotated Tag 推送保持原对象；不创建 annotated Tag。目标 Environment 路由不变，没有新增快照字段、执行队列或 Host。
- 普通提交的所选文件捕获归 Host 临时 index；审核提交沿用既有冻结树和 CAS。`expectedState` 校验加入原审核 admission，已完成 group 的重试不重复提交。post-commit 改变 index、改变 HEAD、通知超时或刷新失败都保留成功提交事实，停止后续发布。
- 独立复核发现并修复了远端/Tag 拼接 ID 冲突、并发相同 Tag 查询窗口、原生 post-ref 通知超时误报失败；均补充确定性回归。审核浏览游标与提交游标分离，范围调整与迟到 catalog 读取不能绕过重新审核或使加载状态卡死。

### 实际执行结果

| 验证                                         | 结果                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| shared Git 契约及 services 全部 Git 定向测试 | 94 项：93 通过、0 失败、1 个既有 POSIX 不可执行 Hook 场景在 Windows 跳过 |
| UI git-action-menu 定向测试                  | 52/52 通过                                                               |
| ConversationStatusPanel 挂载/mini 入口测试   | 3/3 通过                                                                 |
| Web 真实组件浏览器夹具及平台剪贴板测试       | 29/29 通过（25 个交互子场景、1 个套件测试、3 个平台契约测试）            |
| 根 `pnpm typecheck`                          | 通过                                                                     |
| 根 `pnpm lint`                               | 通过，0 warnings / 0 errors                                              |
| `pnpm architecture:check --changed`          | 通过，violations 0 / baseline 0 / new 0                                  |
| `git diff --check`                           | 通过                                                                     |

浏览器覆盖：三个原入口回归、关闭/切换迟到响应、草稿不被覆盖、复制/恢复消息、真正排除审核范围、分组顺序、多个远端失败重试、Tag 四态、最高版本建议、执行前与执行中外部变更、预设按 identity 隔离、目标读取取消/重试、干净仓库 mini 入口、桌面/390px 浅深色无横向溢出。测试使用桩 Host，没有访问用户仓库或调用模型。另用内置浏览器核对桌面与手机布局。

真实 Git 测试仅使用临时仓库/本地 bare remotes，覆盖保护配置、非快进与 Tag 冲突、已有上游各种配置来源、文件字节与 index 变化、所选新建/删除/重命名、Hook、审核幂等及并发 Tag。对当前实际 checkout 只读调用 `getPublishState`：编辑仍在进行时正确拒绝；稳定后成功，耗时约 5.35 秒，index/worktree 指纹均为 64 位 SHA-256。未改变用户仓库 HEAD、index、Tag 或远端。

复现命令（仓库根目录；Git Bash 展开文件 glob）：

```bash
node --import tsx --test packages/shared/src/gitPublish.test.ts packages/services/src/git/*.test.ts packages/services/src/git/repo/*.test.ts packages/services/src/git/providers/*.test.ts
pnpm --dir packages/ui exec tsx --test src/git-action-menu/*.test.ts src/git-action-menu/*.test.tsx
node --test packages/ui/src/v4/ConversationStatusPanel.mount.test.mjs
pnpm --dir packages/web exec node --test test/git-commit-dialog.test.mjs test/platform-clipboard.test.mjs
pnpm typecheck
pnpm lint
pnpm architecture:check --changed
```

本机 Web 测试通过 `LCODE_TEST_BROWSER_PATH` 指向已安装 Chromium；默认 Playwright 所需旧版浏览器不存在。测试入口已修复 Vite ANSI 彩色日志导致 ready 检测误判的问题，并在结束时关闭其浏览器和服务器。新增永久 Web 回归文件已按仓库现有规则加入 `.gitignore` 的精确例外，不扩大整个 test 目录的纳入范围。

### 已知限制与未覆盖

- 本次未构建安装包、未安装或启动新正式版、未发布版本、未在真实远端执行推送。Desktop/Web 共用服务和 UI 的自动化验证不冒充安装版或真手机远控端到端验收。
- 为避免把不完整快照当成一致，发布快照明确拒绝 submodule、特殊文件、超过 100,000 条路径或 2 GiB 内容的仓库；忽略的 untracked 构建/依赖内容不参与。普通手动提交不受此发布快照门禁影响。
- Git 工作树与用户外部 Git 配置没有操作系统级原子锁。冻结 OID 保证不把 Tag/远端指到后来出现的 HEAD；每步前后校验发现变化会停止剩余步骤，不回滚已成功的步骤。
- 额外运行 Desktop renderer 独立 `tsc -b packages/desktop/tsconfig.renderer.json` 失败：145 个既有诊断，其中 141 个为该配置未纳入 `Window.lcode` 声明。只读 compiler-host 覆盖比较本次 adapter 与 HEAD，诊断集合完全一致、新增 0；没有为掩盖结果修改 renderer 类型配置。
- 全仓 `pnpm fmt:check` 仍有大量既有格式失败；没有批量格式化无关文件。本轮新增/修改代码与测试做了定向格式检查，两个 locale 只精确格式化新增 Git 区块；`en-US.ts` 中既有 `settings.modelProvider.removeInvalid.unknownReason` 格式问题保持未动。
- 基线 freshness 的远程 fetch 多次因网络连接重置失败；`--no-fetch` 检查通过（L-GO 与缓存 origin/L-GO 同步，相对缓存 origin/main ahead 47 / behind 0），不能据此声称远程已刷新。

影响模块为 shared、services、ui、web、desktop：服务继续唯一拥有 Git/审核事实，UI 只拥有当前弹窗计划与便利数据，平台仅写当前设备剪贴板。未修改架构 policy/baseline，未提交 Git，保留其它会话的模型设置、Token 统计和工作流展示改动。

变更规模（不含本文档）：任务范围内 23 个既有文件、30 个新增源码/测试文件；扣除 locale 和 `.gitignore` 中已存在的无关净增 11 行，本轮约净增 4,541 行，其中大量为契约、真实 Git 集成和浏览器验收测试。原大文件 `GitActionMenu.tsx` 从 1,816 行缩至 1,155 行，新增实现文件均保持有界，未放宽文件长度或架构规则。

## 三项补丁验收记录（2026-10-01）

- 已修复结果提示：Host 的 `created` 原样投影为执行结果 `tagCreated`，分别显示新建与同目标已存在；幂等成功仍可继续已确认的 Tag 推送，不重复创建。
- 已修复推送错误详情：仅调整显式发布适配器，同时保留 stdout 的逐引用拒绝、stderr 的远端诊断、exitCode、超时/截断元数据和状态变化原因；不改通用 Git 错误转换或重试权限。
- 已修复特殊 Tag 列表：固定原始对象 OID，递归 peel 后按真实对象类型分类；普通/annotated/nested commit Tag 正常列出并保持原对象推送，tree/blob Tag 单独提示而不阻断其它条目。UI 在确认前拒绝与特殊 Tag 同名的创建计划，特殊 Tag 不参与递增建议和可选推送集合。损坏、读取失败、超时、截断或消失对象仍明确拒绝。
- 回归先复现再修复：新增真实临时 Git 仓库覆盖混合对象类型、禁止覆盖、无远端副作用、真实非快进拒绝及注入双通道错误；UI 补 `created` 事实和特殊名称校验；浏览器补新建/幂等提示、390px 浅深色特殊 Tag 提示、正常 Tag 推送及错误详情/单项重试。

| 补丁后验证                               | 结果                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| shared 契约及 services 全部 Git 定向测试 | 123 项，122 通过，0 失败，1 个既有 POSIX Hook 场景在 Windows 跳过      |
| UI git-action-menu / 状态面板挂载        | 54/54、3/3 通过                                                        |
| Web 浏览器夹具与剪贴板契约               | 32/32 通过（28 个交互子场景、1 个套件测试、3 个平台契约测试）          |
| `pnpm typecheck`                         | 通过                                                                   |
| `pnpm lint`                              | 通过，0 warnings / 0 errors                                            |
| `pnpm architecture:check --changed`      | 通过，violations / baseline / new 均为 0                               |
| 定向格式与 `git diff --check`            | 通过；英文 locale 本轮新增区块已格式化，仅保留文末所述既有无关格式差异 |

本轮开始时 `node scripts/check-workspace-freshness.mjs` 的 fetch 与基线检查已成功，消除了前一轮远程未刷新状态；L-GO 与 origin/L-GO 同步，相对 origin/main ahead 47 / behind 0。影响模块仅 shared、services、ui、web，所有者、事件顺序与 Desktop/Web 交付边界不变。以补丁开工文件为基线，不含本 spec，约净增 615 行，其中多数为回归测试；没有把此前整套增强或其它会话改动计入本次补丁。

验证继续只使用临时 Git 仓库/本地 bare remotes 与桩 Host；未构建或安装软件，未提交 Git，未推送真实远端。全仓既有格式问题及安装版/真手机验证边界不因本次补丁而改变。
