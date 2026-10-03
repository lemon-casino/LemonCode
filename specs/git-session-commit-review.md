# 多会话补丁拆分与 AI 提交审核

当前界面生命周期与跨端状态以 [工作树界面](worktree-ui.md) 和 [跨端审核编辑状态](git-review-cross-platform-state.md) 为准：关闭只隐藏控制器，scope/logEpoch 切换拒绝旧响应；历史验证记录中的“关闭后失效”描述属于先前版本，不再作为现行关闭规则。

## 已确认的产品规则

- 沿用任务实时完成后的自动提交信息入口；普通、计划、工作流一致。生成、审核不自动暂存、提交或推送，用户确认才执行。
- 能用工具逐次 before/after 内容验证的修改按会话拆分；同文件的 A → B 增强可形成依赖顺序。会话依赖环、版本链缺失、重复/分叉链、外部写入、旧记录缺失均不能猜测作者，合并审阅。
- AI 只能审核已冻结的补丁、建议合并/依赖/人工确认及生成当前语言的 Conventional Commit 信息；不能创造归属、改变补丁、恢复被覆盖功能或自动删除代码。
- 提交信息生成、审核捕获和发布快照不设文件数量上限。文件数不能作为拒绝条件；Git 路径参数按命令字节预算分批，单批限制不是总文件数限制，不改变用户选中范围。
- 二进制、内容超限或审核失败仍通过实时完成入口显示弹窗及失败原因；服务继续用当前模型、语言、选中范围与会话上下文生成仅供编辑的提交纪要，但不返回可提交 review。必须重新审核或明确选择普通手动提交，不能静默降级后直接提交。模型请求本身失败时明确保留失败原因，不伪造成功消息。
- 确定性拆分证明的是可重放的补丁归属，不证明功能独立。AI 指出功能依赖或矛盾时保守合并或要求人工确认，不按模型置信分数绕过确认。
- 不按时间段、行号或完成摘要猜测作者。补丁的 before/after 内容是版本锚点，历史记录无法形成唯一链时进入合并审核。
- Edit 的完整 after 可由严格 structuredPatch 重放得到；与冷恢复共用同一无 fuzz 重放函数。Windows CRLF 原文按 Git 内置 clean 规则锚定 HEAD；外部 clean filter 不自动归属，转为合并审核。
- 新文件、删除、换行、空文件必须保留准确内容；二进制、符号链接、子模块、冲突和超限内容不做按行拆分，显示明确不可处理原因，保留旧手动 Git 路径。
- 分组预览的文件存在性与模式以该组的前一版本为准；A 新建后 B 增强，B 必须显示普通修改，不能重复显示为新文件。
- 自动草稿仍只消费一次；已打开弹窗的用户输入不被后台结果覆盖。一次提交候选只提交已审阅的冻结内容；另一个会话随后继续写入的内容保留在工作区。

## 所有者与接口

| 事实                      | 唯一所有者                                    | 接口/边界                                                                                                                                  |
| ------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 每次工具文件修改          | CLI 已有 workspace checkpoint / session entry | 复用持久化检查点，不增加数据库；新增严格只读 `workspace/fileMutationJournal` 返回目标 identity 内的逐次内容证据                            |
| journal 查询              | CLI bootstrap                                 | 精确 identity 隔离，本地无 identity 才按路径；限制会话数、条目数和内容字节；不足/不可读显式 incomplete，不恢复新会话、不启动模型           |
| HEAD/index/工作树与候选树 | 目标 Host 的 Git repo adapter                 | 临时 index 捕获不可变 Git tree，不改变真实 index/工作区；内容/HEAD/index 均参与版本校验                                                    |
| 审核快照、分组与消费状态  | 目标 `IGitService`                            | `generateCommitMessage(review=true)` 返回审核快照引用、分组和 AI 意见；`commit(review)` 验证快照、分组顺序和确认，再提交                   |
| 会话分组算法              | services Git 纯函数                           | 唯一内容链 → 会话依赖图 → 有序候选；任何不足保守合并，不引用 Runtime 实现                                                                  |
| AI 审核                   | 既有 GitCommitMessageGenerator                | 同一目标模型/语言；严格 JSON schema；模型只能返回既有 group id 与允许的意见                                                                |
| 弹窗选择、输入、人工确认  | UI GitActionMenu / hook                       | 展示审核摘要、关联会话、合并原因与警告；冻结 diff 与文件范围在独立 PreviewPane 中查看，并可返回审核；不拥有服务端审核事实、不直接调用 repo |

审核引用仅在所属 Git 服务生命周期内有效，服务重启后重新审核。不把 UI 草稿持久化成任务完成事实。快照身份绑定 `workspaceIdentity?.trim() || workspacePath`，远程请求保留 `remoteSessionId` 的现有目标 Environment 路由。

## 时序与幂等

```text
CLI Write/Edit → 既有逐次 checkpoint artifact + session entry
                                         ↓ 只读 journal
任务完成/手动生成 → 目标 GitService → repo 冻结 HEAD/index/选中文件 tree
                                  → 校验逐次内容链，形成有序会话候选/合并候选
                                  → 当前模型审核同一候选快照
                                  → 再校验版本，发布 reviewId + 分组/消息/意见
UI 预览、编辑消息、确认 → GitService → repo 校验 HEAD/index/工作树
                                    → 仓库 index 锁 + 冻结候选树 + 原生提交前 Hook
                                    → 再校验候选树/快照 + ref CAS（含 reference-transaction）
                                    → 更新仅本次提交的 index 内容，保留其它暂存和工作树
                                    → 原生 post-commit（失败只返回已提交警告）
                                    → 记录 group 消费事实，再允许下一个组
```

- Desktop continuous 与手机 replayable 复用同一目标 Host Git 服务。journal 为无副作用查询，不增加第二份命令队列、CLI 或 Host。
- Git 版本变化、切换分支、另一个窗口提交、已有 index 锁或旧 reviewId：拒绝旧审核提交，用户重新生成/审阅；不能仅比较增删行数。
- 不同 workspace 子目录指向同一个实际 Git checkout 时，repo 锁与 ref CAS 共用真实 Git 事实，不能仅按 session key 串行。
- 有序组按顺序提交；同一 review/group 重试不得重复创建提交。已成功提交的组明确记录，即便后续状态刷新/推送失败也不重做 commit。
- UI 游标也以 reviewId/groupId 幂等推进；同组重复成功响应或旧审核延迟响应不能跳过尚未提交的下一组。
- 原子提交失败发生在 ref CAS 之前时，审核路径不改变 HEAD/真实 index/工作树；Hook 自行修改的工作树不得擅自回滚，显示重新审核提示。ref 已更新后的恢复错误须携带已提交事实，不能声称未提交。
- 旧手动路径兼容。审核路径不能绕过仓库签名或活动 commit hooks；原生执行可安全支持的 Hook，不因 Hook 文件存在就拒绝。当前签名能力不变，要求签名或 Git 不支持原生 Hook 入口时明确拒绝并保留原手动提交入口。

## 模型候选警告兼容（2026-10-02）

现场审核响应在 `messages[0]` 多返回 `warnings`，旧严格对象校验在合法消息处理前拒绝整份审核。原生成 prompt 的标准输出仍为顶层 `warnings` 与仅含 `id/message` 的候选；补充明确字段层级和完整 JSON 示例，不能因兼容而鼓励自由增加字段。

- `commitReviewModel` 是模型输出归一化的唯一所有者，只新增识别候选内可选 `warnings: string[]`。它复用顶层警告的非空、长度与数量限制；其他未知字段、错误类型、非法或重复 id、遗漏候选和无效 Conventional Commit 仍拒绝，不能用 passthrough/strip 丢弃未经审核内容。
- 有效候选警告保留对应候选 id，汇总、去重为原顶层审核警告；对外候选仍仅有 `id/message`，不新增 shared 协议字段或 UI 状态。候选警告不得静默丢弃、写入提交消息或当作执行指令。
- `CommitReviewService` 仍是审核事实与提交确认的唯一所有者，沿用任何警告即要求人工确认的保守规则。模型 decision 不提升证据归属可信度，不因格式兼容而自动提交或跳过确认。

```text
模型响应 → commitReviewModel 严格校验合法字段/候选/消息
         → 候选 warnings 汇总到既有顶层 warnings
         → CommitReviewService 原版本检查、人工确认规则 → 原 review
         → Desktop continuous / Mobile replayable 原弹窗消费路径
```

不增加模型请求、重试、队列、缓存或新的失败兜底；真实请求失败仍保持失败。验收覆盖候选警告保留及关联、空警告、旧格式兼容、非法警告/未知字段拒绝、输入不变和有警告时未确认提交被服务拒绝。

### 本轮验证

- 先用候选内 `warnings` 复现同一 `unrecognized_keys`，修复后 17 项定向服务测试全部通过：解析、服务确认拦截、旧标题归一化和隔离临时 Git 仓库的提交/Hook/版本失效集成。未调用真实模型、修改用户会话、运行用户仓库 Hook 或提交用户仓库。
- 根 `pnpm typecheck`、`pnpm lint`（0 warnings/errors）、4 个触及文件格式检查与 `git diff --check` 通过；架构检查 baseline 0 / new 0。影响仅 `services`，保留模型归一化与目标 Host GitService 的原所有者和上图顺序，无新协议、UI 状态或平台分支。相对编辑前独立基线，代码与测试净增 112 行，不含共享工作树此前改动。
- 未构建、安装或重启应用；测试验证源码行为，不代表已安装版本已经更新或真实模型从此永远返回合规格式。

## 审核提交 Hook 生命周期（2026-10-01）

- 所有者仍为目标 Host 的 GitService/CommitReviewRepo；复用 GitCommandProvider 的原生 Git 命令，无新 UI 状态、队列、协议或跨平台 shell 实现。
- 通过 `git hook run --ignore-missing` 依次执行 `pre-commit`、`prepare-commit-msg`、`commit-msg`；由 Git 解析 `core.hooksPath` 和可执行性。缺失/不活动的 Hook 不拦截，Husky 占位脚本正常执行；不设置跳过 Hook 的环境或 Git 参数。
- 提交前 Hook 使用冻结候选的临时 `GIT_INDEX_FILE` 与 `GIT_EDITOR=:`。消息 Hook 接收消息文件；prepare 的来源参数为 `message`。允许消息 Hook 校验/补充提交消息，空消息拒绝。消息文件有界，使用 Git stripspace 清理尾部空白。
- 每个提交前 Hook 返回后，必须复核临时 index 的完整树仍等于已审核树，再校验 HEAD/真实 index/选中文件工作树。Hook 拒绝、超时、改写候选树（含暂存其它会话的内容）或修改选中文件时，在 ref 更新前拒绝；真实 index 不发布，Hook 自行写入的文件保留，用户重新审核。不能静默采用格式化后的未审核补丁。
- `reference-transaction` 由原生 `update-ref` 执行，不重复手动执行；prepared 阶段拒绝时保持未提交事实和真实 index，保留 CAS 并发保护。
- `update-ref` 的 committed 通知阶段超时或返回异常时，只读核对目标 ref；若已精确指向本次 commitHash，继续发布已准备 index 并返回成功警告，不能把已提交事实当作失败。ref 不匹配或无法可靠读取时仍拒绝，不覆盖其它窗口的 HEAD。
- ref CAS 成功后才更新真实 index 并执行 `post-commit`。通知 Hook 失败/超时返回 commitHash 与明确警告，不能报成未提交或自动重试；原 review/group 重试复用已有 commitHash。Hook 改变工作树或出现警告后，剩余候选重新审核。
- Desktop continuous 与 Web remote replayable 均复用原目标 Host 提交服务及 review/group 幂等边界；不改变语言、人工确认、自动弹窗或普通手动提交入口。
- 验收使用隔离真实 Git 仓库：自定义路径/空 Hook、三个提交前 Hook 顺序和消息改写、候选 index 隔离、Hook 拒绝、Hook 篡改补丁/工作树、reference-transaction 拒绝、post-commit 失败后的重复请求。Windows 本机执行，POSIX 可执行性另设条件测试，不声称 macOS/Linux 已实机验证。

### 本次验证记录

- Windows Git 2.49.0：59 个定向测试，58 通过、0 失败、1 个 POSIX 不可执行 Hook 测试按平台跳过。覆盖 planner/model/service、Git UTF-8 管道、真实仓库 Hook 生命周期、冻结 index 隔离、CAS、消息字节限制与公开服务重试幂等。
- Hook 超时、Git 原生入口不支持、输出截断及引用更新后通知异常通过注入命令结果验证；其余 Hook 校验使用临时仓库中的真实可执行脚本。没有执行用户仓库的提交或 Hook，也没有调用真实模型。
- 根 `pnpm typecheck` 与 `pnpm lint` 通过（0 warnings/errors）；changed 架构检查 baseline 0、new 0；8 个触及文件的定向格式检查通过，`git diff --check` 通过。
- 架构边界保持为 services/repo 内部：GitService/CommitReviewRepo 继续唯一拥有审核提交事实；Hook 与提交事务操作抽取为有界内部函数，不增加缓存、状态所有者、UI 写入路径或协议。事件顺序与 Desktop/Web 的幂等入口沿用上图。
- 本轮新增 Hook 实现、事务实现及 Hook 回归测试三个文件，共 409 个非空行（含注释）；其余文件此前已是未跟踪改动，无法用 HEAD 精确区分本轮净增，不把全量现有文件统计冒充本轮增量。保留其它本地修改，未放宽文件长度限制。
- 用户明确本轮不构建。没有重新打包、安装、重启应用；既有安装包不含本次修复，后续收到构建请求再生成正式版。

## 代表性验收用例

| 编号 | 准备/动作                                            | 断言                                                    | 验证层              |
| ---- | ---------------------------------------------------- | ------------------------------------------------------- | ------------------- |
| R1   | A/B 同文件不同区域，有完整逐次 checkpoint            | 两个候选只含各自补丁，最终合成等于冻结 diff             | 纯算法 + 真 Git     |
| R2   | A 实现，B 在同段增强                                 | A → B 有序提交；第二组不以不包含 A 的 HEAD 独立提交     | 纯算法 + 真 Git     |
| R3   | A → B → A 或缺 before/after/外部写入                 | 合并候选，不伪造作者；AI 意见不能强行拆分               | 算法 + 模型 fixture |
| R4   | 修改内容但增删行数不变/审核后 HEAD 变化              | 拒绝旧 review；无暂存、无提交副作用                     | 真 Git              |
| R5   | 用户预先暂存另一个文件/同文件其他补丁                | 提交候选不包含无关内容，真实 index 与工作树保留其它修改 | 真 Git              |
| R6   | 模型请求失败、非法 JSON、编造 group id 或依赖环      | 不发布可提交审核，不改变 Git；可手动重试                | 服务 fixture        |
| R7   | 不同 identity 同路径，冷会话/子 Agent/workflow actor | 不跨 identity 查询；可读 checkpoint 恢复，不启动任务    | CLI 查询 fixture    |
| R8   | 连续确认/网络重试、同 checkout 两个窗口提交          | 同组只提交一次，旧 HEAD CAS 失败；不覆盖新内容          | 真 Git + 服务       |
| R9   | 自动完成弹窗/手动重新生成/手机窄屏                   | 显示分组 diff、合并警告与确认；已编辑输入不被覆盖       | UI 集成/E2E         |
| R10  | 新建/删除/CRLF/无末尾换行/超限/二进制                | 文本内容准确；不可处理明确阻止审核提交，不空内容替代    | 真 Git              |

验收测试必须实际执行并记录；未执行的安装版交互不能写成通过。全仓 typecheck、lint 与 changed 架构检查必跑，不自动更改存量无关文件。

## 影响范围与迁移

新增能力跨 shared 协议、CLI 只读证据查询、services Git repo/审核与共享 UI。不修改任务 admission、owner/lease、预览服务生命周期和已确认的实时弹窗规则。旧 CLI 不支持 journal 时只能合并审核，不能将方法缺席当作归属证据。现有功能图没有提交审核节点且图契约文档缺失，记为 graph-drift-candidate，源码/spec 是本次边界依据。

## 空提交信息弹窗回归修复（2026-09-30）

- 已复现：Git stdout 的数据块可截断 UTF-8 中文/emoji；逐块 `Buffer.toString` 会改变有效文本的字节，导致审核的 blob 哈希校验错误拒绝。在命令 adapter 内分别为 stdout/stderr 保留跨块解码状态，结束时刷新尾部；保留原有字节上限、超时和严格 blob 校验，不能放宽二进制限制来掩盖读取错误。
- 自动草稿的路径是生成时的冻结范围。弹窗刷新和预填校验使用同一范围，不能合并后来变化的 task meta 路径并将原草稿误判为过期。无自动草稿的普通手动入口继续沿用任务范围。
- 生成失败和已过期是显式 UI 错误，不是已生成的空消息。过期时不采用旧 message/review；即使范围变化也不能丢失已有失败原因。提交与提交并推送保持禁用，直到重新审核或用户明确选择普通手动路径。
- 服务及 renderer 记录一次低频失败/过期诊断与结果是否可用，不记录补丁、提交文本或模型凭据。已有草稿 key 的一次消费规则和已打开弹窗输入不被覆盖的规则不变。
- 唯一所有者不变：命令 adapter 拥有解码器；GitService 拥有审核事实；SessionPane 拥有局部自动结果；GitActionMenu/hook 拥有弹窗输入与错误。没有新的持久化或重试队列。

```text
Git bytes → Git command adapter（stdout/stderr 各自连续解码）
          → GitService 冻结/哈希校验 → 审核结果或明确错误
          → SessionPane 发布局部草稿（成功与失败分开记录）
          → GitActionMenu 用草稿原范围刷新/校验
             ├─ 有效：预填当前语言消息及冻结审核
             └─ 失败/过期：显示原因、禁止审核提交、允许重新生成/明确手动
```

Desktop continuous 与手机 replayable 仍使用同一目标 Host Git 服务；自动草稿只对实时完成生成，不参与冷恢复。

## 文件数量不限与消息/审核分离（2026-10-01）

现场 `sess_35990067-9018-4035-9b01-450c2e520079` 的 105 文件因旧 100 文件上限在 AI 请求之前被拒绝。新的规则不设 100、1000 或其它总文件数门槛；空范围仍拒绝，冲突、二进制、内容字节预算、Hook、版本校验与人工确认边界不放宽。

```text
任务完成 / 手动生成 → 同一目标 GitService（保持选中范围）
                     → Repo 分批传递路径，冻结完整候选
                     ├─ 审核成功 → 消息 + 可审阅 review
                     └─ 审核不可用 → 同一消息生成器 → 消息 + reviewError（无提交权限）
                     → Pane / Menu 校验同一 Git 指纹
                        ├─ 未过期 → 预填纪要，独立显示审核结果/失败
                        └─ 已过期 → 不采用旧消息/review
```

- 服务、Repo、Pane 和 Menu 所有者不变，没有新增队列、重试或持久化。纪要不是冻结补丁的授权，审核错误依然阻止按钮与快捷键提交；手写内容不被异步结果覆盖。
- AI 输入按字符预算压缩/抽样并明示省略量，不按固定文件数量拒绝；内容超限不意味着清空纪要。截断的冻结审核继续合并、要求人工读取完整预览与确认。
- 分批读取只合并同一选中范围的输出，保留 literal-pathspecs、NUL 文件名与旧版本校验；平台统一使用 GitCommandProvider，不引入 shell。
- 验收：105+ 文件真实仓库成功调用审核模型、中文预填且 HEAD/index 不变；长中文/特殊文件名跨批完整捕获；1000+ 候选仍可生成纪要；内容超限生成纪要但无 review；模型失败显式提示；桌面与手机宽度自动/手动入口显示相同纪要，按钮和快捷键仍受审核状态控制；过期/关闭/切换会话不接受迟到结果。

### 本轮源码验证

- Windows 下先复现 105 文件数量拒绝、内容超限导致空纪要、审核失败预填清空。修复后第一组 services/UI 回归 82 项：81 通过、1 个 POSIX Hook 测试按平台跳过；追加的模型预算、服务、发布状态与预填回归 27 项全部通过（与第一组有重复，不累计成独立用例数）。
- 最终规模集成 4 项通过：105 个长中文/空格/特殊字符文件分别走未暂存与仅已暂存审核，完整范围保留且生成不改变真实 HEAD/index；内容超过 2 MiB 仍生成中文纪要但无审核授权；模型失败保留明确错误；1000 文件纪要请求正常。纯函数另验证 10001 路径完整分批，以及 10001 文件模型输入有界、预算内补丁不误截断。
- 实际共享 GitActionMenu 浏览器夹具 30 项通过，覆盖桌面/390px、浅深色、自动/手动纪要、审核不可用时阻止按钮及快捷键提交、用户输入不覆盖、关闭/切换后迟到结果失效。夹具只用模型/服务桩；服务集成只操作临时仓库，不运行用户仓库 Hook、模型请求或提交。浏览器与 Vite 服务已清理。
- 根 `pnpm typecheck` 通过；根 `pnpm lint` 仍失败，仅剩并行工作流实现的 `packages/web/test/fixtures/workflow-execution-progress.tsx` max-lines 444，未修改该无关文件。本轮 17 个触及代码/测试文件定向 lint 为 0 warnings/errors，19 个触及文件格式检查与定向 diff-check 通过。changed 架构检查 baseline 0、new 0。
- 影响为 services/repo、共享 UI 与 Web 测试，目标 Host GitService/Repo 仍唯一拥有审核事实；摘要生成与授权结果分开，事件顺序沿用上图，桌面/手机不新增第二份状态队列。可独立比较的 6 个追踪文件相对 HEAD 为 +114/-32（净 +82），本轮新增 4 个实现/测试文件共 229 行；其它触及文件原本已有并行改动，不把其全量 diff 冒充本轮净增。架构治理技能用于保持原服务入口及所有者边界。
- 本轮仅修复与验证源码，没有构建、安装、重启或推送。已安装正式版不含本次修复，后续按用户构建指令再打包。

新增回归验收：

1. stdout/stderr 在中文三字节及 emoji 四字节内部断块，解码准确；不完整尾字节仍可检测，超限仍报告 truncated。
2. 真实 Git 仓库中大于管道块大小的中文文件，公开 `generateCommitMessage(review=true)` 进入模型 fixture 并生成中文审核消息；真实 index/HEAD/工作树不改变。
3. 自动草稿仅含 A 文件，task meta 同时含 B：弹窗仍仅采用 A 的审核，不误失效。
4. 失败自动草稿正常显示原因；失败且 Git 指纹已变化、成功但打开前过期、缺审核结果：显示错误且不能直接提交。
5. 自动弹窗的中文预填、重新生成、已编辑输入不覆盖、关闭后不重复打开，在桌面及 390px 窄屏浏览器夹具中验证；真实模型和安装版由用户后续测试。

本轮修复验证：

- 测试先行复现旧解码和大中文审核失败；修复后本轮运行的 services/UI 定向 Node 测试 50/50 通过（包含 8 项新增回归）。
- 对现场相同 `zh-CN.ts` HEAD blob 做 4 次只读审核读取，428498 bytes 均准确，替换字符为 0；没有调用真实模型或修改仓库 index/HEAD。
- 实际 GitActionMenu 浏览器夹具验证：自动中文预填、只采用草稿 A 范围而非 task meta A+B、未确认禁用提交、新草稿不覆盖已编辑输入、失败/过期/失败且过期均显示原因并禁用按钮和快捷键、窄屏重新生成中文成功且无横向溢出。仅夹具服务，无真实提交。测试浏览器和 Vite 服务已关闭。
- 根 `pnpm typecheck`、`pnpm lint`（0 warnings/errors）、`pnpm architecture:check --changed`（0 violations）通过；`git diff --check` 通过。本轮涉及 services、ui 与 Web 夹具，未改变状态所有者、接口或依赖方向。
- `pnpm fmt:check` 仍失败：报告 2618 个既有格式问题，未批量格式化无关文件。本轮 14 个触及文件单独格式检查通过。格式器首次 Windows 写入异常单独重试成功，语言文件内容完整。

## 本次验证记录（2026-09-30，Windows）

确认控件布局：复用主题化 Checkbox，固定 16px 且不收缩；文字显式 24px 行高，控件距行首 4px，使单行居中、多行与首行居中对齐。桌面、390px 窄屏、浅/深色均验证。

- 定向 Node 测试：53/53 通过。覆盖 planner/model/service、真实临时 Git 仓库、公开 Git 服务集成、CLI checkpoint 重放与 journal、自动完成闸门和 UI 游标；模型输出使用 fixture，没有向真实模型发送仓库内容。
- 浏览器夹具使用实际 GitActionMenu：桌面及 390×844 窄屏验证自动弹窗、未确认时按钮及 Ctrl+Enter 禁止提交、A/B 顺序确认、提交后关闭、不重复打开。审核路径 stage 次数为 0。
- 浏览器额外验证：不可处理错误仍弹窗且禁用提交；过期快照返回拒绝，没有提交或暂存；明确选择普通手动路径后恢复旧入口。这些是开发夹具结果，不代表已安装正式版任务验证。
- `pnpm lint`：通过（0 errors，1 个既有 Git 备份测试 unused import warning）。`pnpm architecture:check --changed`：通过，0 violations。
- 根目录 `pnpm typecheck`：失败。诊断位于 `gitBackupState.test.ts`、`gitBackupStore.ts`、`GitBackupWelcomeDialog.test.tsx`、`useGitBackup.test.ts` 的现有 Git 备份改动；本次未修改这些文件来掩盖失败。
- CLI 根 `pnpm typecheck` 缺少 turbo 入口；执行触及的 contracts/adapters/core/bootstrap 四个包各自 `typecheck`，全部通过。CLI 整包 lint 有既有文件长度限制等失败；本次修改的有界 CLI 文件单独 lint 通过。
- 本次触及文件单独格式检查通过；尚未构建或安装新的正式版包。旧 checkpoint 无法补造来源标记，继续使用合并审核。

## 后续本地正式版构建（2026-09-30）

- 在 `LCODE_ENV=production`、正式 LCode 身份下构建 Windows x64。重新执行根目录 `pnpm typecheck` 与 `pnpm lint` 均通过，lint 为 0 warnings / 0 errors；先前 Git 备份模块阻塞已不再出现。
- 原始 bundle 命令在重复准备资源时遇到 node-repl-host 生成声明文件的 Windows TS5033 写入错误。单独重试及重新封装 Agent 成功；随后执行 `build:no-runtime-assets` 重新编译桌面，再以 `--skip-prepare --skip-build` 继续打包本轮产物，没有跳过最终校验。
- 产物：`packages/desktop/dist/LCode-3.16.5-win-x64.exe`，150330712 bytes（143.4 MiB），文件时间为 18:51:02 +08:00。构建元数据时间为 18:48:44 +08:00。
- SHA-256：`69CFD46AB680FF0EEF51F4F239AC3E03CC5BDBF88C319627158776B362255AC9`。
- bundle 最终退出码为 0，运行依赖、正式产品身份及 500 MiB 体积上限校验通过。额外只读检查确认 app.asar 含会话拆分/合并审核及 UI 弹窗代码，包内 Agent 含 journal/provenance 协议且哈希与本轮 CLI 编译结果一致。
- 未自动安装或运行正式版应用，安装版交互由用户继续测试。构建使用本机 Node 24.14.1，CLI 对指定 24.14.0 给出非阻断版本警告。

## 空提交信息修复后的正式版构建（2026-09-30，20:37）

- 本轮 services/UI 定向测试 50/50、CLI checkpoint/journal 回归 6/6、普通/计划/工作流完成与后台预览回归 3/3 通过，合计 59 项。后两组沿用现有测试；模型审核仍使用 fixture，不代表真实模型或安装版任务验证。
- 完整执行 `LCODE_ENV=production`、`LCODE_PREVIEW_IDENTITY=0` 下的 `pnpm bundle:desktop -- --os win --arch x64`，退出码为 0；没有使用跳过资源准备或桌面编译参数。运行依赖、正式产品身份及 500 MiB 体积上限校验通过。
- 新产物：`packages/desktop/dist/LCode-3.16.5-win-x64.exe`，150349418 bytes（143.4 MiB），文件时间为 20:37:22 +08:00；构建元数据时间为 20:34:52 +08:00，版本仍为 3.16.5，覆盖前述 18:51 的旧构建。
- SHA-256：`9A448D1B2AC53624C47351B0CAD12EA2CA89FFA4A43B79F35746300BB949FC32`。
- 只读检查新 app.asar：Host 包含 stdout/stderr 独立的 UTF-8 StringDecoder、跨块 write 与结束 end 刷新及审核失败日志；renderer 包含自动草稿预填校验和过期提示。检查按实际生产压缩代码和 Unicode 转义进行，不以源码变量名或未转义文本判定代码缺失。
- 修复保留冻结审核与人工确认，不自动提交或推送；未自动安装、启动或终止用户现有应用。用户后续测试需安装这一新时间戳的包。
- 最终 changed 架构检查：baseline 0、new 0。触及 services、ui 和 Web 测试夹具，状态所有者及事件顺序沿用本节设计；7 个已有生产代码文件相对 HEAD 合计新增 794 行、删除 87 行、净增 707 行。此统计含此前未提交的审核功能和语言项，不冒充本轮单独增量，也不包含未跟踪的测试、夹具和 spec；未恢复或清理其它本地改动。
