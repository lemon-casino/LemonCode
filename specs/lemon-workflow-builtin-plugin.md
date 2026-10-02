# Lemon Workflow 内置插件

## 目标

LCode 的源码构建、桌面安装包、CLI SEA 和远端 Agent 资源必须内置一个默认启用的
`lemon-workflow` 内容插件。插件提供 `/lemon` 命令以及 `ponytail`、`caveman`、
`dynamic-workflows` 技能，不依赖用户目录 `~/.lcode` 中已有文件。

动态工作流能力缺省为 `alwaysOn`。远端配置或本地开发覆盖仍可显式设置
`disabled`，但配置缺失、非法或请求失败时不得让内置 `/lemon` 落入“命令存在、工具未装配”
的半可用状态。

## 产品规则

1. `lemon-workflow` 是纯内容型官方插件，首次启动默认启用，不启动独立进程，不新增 MCP。
2. 插件内容是构建和运行时的唯一来源。不得在启动时从 `C:\Users\Lemon\.lcode` 复制文件。
3. `/lemon [任务描述]` 使用参数作为目标；参数为空时使用当前对话中最新任务。
4. 新任务第一次调用 `CreateWorkflow` 时只传一个内联 `script` 来源。不得调用
   `EvalWorkflowSnippet`，不得同时传 `path`、`saved` 或其他 snippet 来源。若编译失败，编辑工具
   返回的草稿并以 `path` 重交，不能再次输出整份脚本。
5. 当目标明确要求继续、恢复或唤醒现有 run 时，先使用 `GetWorkflowRun` 或
   `ListWorkflowRuns` 确认 run。仅对 `status === "stopped"` 且
   `stopReason !== "superseded"` 的同一 run 调用 `ResumeWorkflowRun`；`provider` 停止
   原因需先排除供应商故障。不得创建重复 run，不得恢复 superseded 或 errored run。
6. 用户明确要求修改原 workflow 时使用现有 `AmendWorkflow` 语义，不把脚本变化伪装成 resume。
   已知精确旧片段的小改动优先用单次 `edits`；片段已不在上下文时才编辑 run 的脚本文件并传
   `path`；只有整体重写才传完整 `script`。
7. `CreateWorkflow` 返回编译诊断时，按诊断编辑结果中命名的草稿，再以 `path` 重新调用
   `CreateWorkflow`。不得把整份脚本再次内联、重复提交同一个无效调用或退回
   `EvalWorkflowSnippet`。
8. Ponytail 与 Caveman 保持各自上游 MIT 许可和署名；项目对 `/lemon` 与
   `dynamic-workflows` 的本地编排修改单独维护。
9. `/lemon` 是命令而非名为 `lemon` 的技能。命令只请求插件实际提供的
   `lemon-workflow:dynamic-workflows`、`lemon-workflow:ponytail` 和
   `lemon-workflow:caveman`；不得调用 `Skill(lemon)`。
10. 对未指定 Git 范围的“审查当前改动”，workflow 先读取 `git.changedFiles()`：有
    实质内容时审查工作区相对 `HEAD` 的改动，不以仅有 `git status` 标记的生成文件
    代替差异；没有工作区差异且 `git.log(2)` 有父提交时，明确告知用户切换至
    最近一次提交，以 `git.changedFiles("HEAD^")` 和 `git.diff("HEAD^", path)`
    为审查证据。若两种范围均无内容，或历史不足以比较，则报告确切原因，不派发
    审查代理、也不编造发现。用户明确指定未提交文件、某个提交或基准时，严格使用
    指定范围，不自动回退；所有代理和最终报告使用同一个已宣布的比较基准。
11. Ponytail 是工程决策规则，不是独立专业角色。`/lemon` 在编排拓扑时避免无收益的
    actor 和阶段；为任务本来需要的规划、编码、重构和代码审查 actor 写入精简 Ponytail
    persona：先理解完整路径，再依次选择不新增、复用仓库现有实现、标准库或平台能力、
    已安装依赖、最小正确实现。不得因精简而删除信任边界校验、防数据丢失错误处理、
    安全、无障碍或用户明确要求的验证。不为 Ponytail 单独新建 actor，不复制完整
    `SKILL.md` 到每个 prompt。
12. Caveman 是用户可见表达规则，不是内部结果压缩器。它只约束简短 `log()` 进度和最终短摘要；
    actor 之间的指令、typed result、证据、代码、命令、路径、数字、精确错误、测试结果、
    安全警告、`report()` 项和 artifact 保持完整。用户要求详细报告，或精简会产生歧义时，
    使用正常完整表达。不为 Caveman 单独新建 actor，不接入或启用 Caveman proxy、
    engine、rewriter 或生命周期 hook。

## 状态所有者与边界

- 官方插件 definition、默认启用集合和构建资源清单负责“插件是否随发布物存在”。
- `resolveDynamicWorkflowClientConfig` 负责动态工作流缺省开关；远端合法值和本地覆盖优先级不变。
- `DynamicWorkflowRunService`、run journal 与现有 workflow tools 继续唯一持有 run 状态、恢复判定、
  owner/lease、问题等待和后台追踪。
- `/lemon` 只提供模型执行约束，不持久化 run，不复制 journal，不建立第二条恢复路径。
- Ponytail 和 Caveman 的作用域由 `/lemon` 在生成的 script/persona 中表达；不属于
  Runtime 可变状态，不新增运行时开关、队列、缓存或转发层。
- Git 内容差异仍由现有 `git.*` workflow world reads 持有；命令仅选择审查基准，
  workflow 不保存第二份 Git 状态，也不修改共享 Git 原语的缺省语义。

```mermaid
sequenceDiagram
  participant User as 用户
  participant Command as /lemon
  participant Tools as Workflow tools
  participant Runs as DynamicWorkflowRunService
  participant Actor as Workflow actor

  User->>Command: 新任务或恢复请求
  alt 明确恢复现有 run
    Command->>Tools: GetWorkflowRun/ListWorkflowRuns
    Tools->>Runs: 读取 journal 与 resumable 状态
    Runs-->>Tools: run 状态
    Tools-->>Command: 可恢复性与 run_id
    Command->>Tools: ResumeWorkflowRun(run_id)
    Tools->>Runs: 同一 run ID 恢复
  else 新任务
    Note over Command: Ponytail 选择最小拓扑并写入工程 actor persona
    Command->>Tools: CreateWorkflow(script + scoped personas)
    Tools->>Runs: 创建并追踪新 run
    Runs->>Actor: ask（工程角色带 Ponytail 约束）
    Actor-->>Runs: 完整 typed result / 证据 / 错误
    Runs-->>User: Caveman 短进度/短摘要；完整 report/artifact
  end
```

## 分发接口

以下入口必须同时声明并校验 `lemon-workflow-plugin`：

- Bootstrap 官方插件 definition 与默认启用集合。
- Desktop `bundled-agents/<platform>/glm/packages` 生产资源。
- Desktop dev 与 production 共用的 `stage-agent-bundle.mjs` 资源暂存。
- CLI SEA 官方插件资产 manifest。
- Remote prebuild GLM 资源与开发态远端资源合同。
- pnpm workspace lockfile 与第三方许可证清单。

许可证生成器若在 Windows 的全 workspace `pnpm ls` 查询遇到 `EMFILE`，必须保留相同的
prod/lockfile 双图校验，通过逐 workspace 查询降低同时打开的文件数，不能跳过许可材料生成。

每条分发路径至少校验以下资产：

- `.lcode-plugin/plugin.json`
- `commands/lemon.md`
- `skills/ponytail/SKILL.md`
- `skills/caveman/SKILL.md`
- `skills/dynamic-workflows/SKILL.md`
- `skills/dynamic-workflows/examples.md`
- `skills/dynamic-workflows/patterns.md`

Desktop 共享 staging 同时暂存 `lemon-workflow-plugin` 和仓库自研的 `lcode-cua-plugin`。隔离测试必须从仓库源码准备两个完整内容包，包含各自的隐藏 manifest 目录，不能只拷贝 lemon 后调用完整 staging，也不能从用户插件缓存补齐 Computer Use。正向验收逐文件比较暂存内容与源码；任一 Computer Use 必需资源缺失时，仍须由原 staging 校验明确拒绝，不把插件改成可选或创建空占位文件。

## 验收场景

1. 全新用户目录启动源码或安装包，无需 `/reload-plugins` 即可发现 `/lemon` 和三个技能。
2. 没有远端 dynamic workflow 配置时，session 仍装配 Create/Get/List/Resume 等 workflow tools。
3. 远端显式下发 `disabled` 时，workflow UI、tools 与 `/lemon` 入口按现有灰度边界关闭。
4. `/lemon 新任务` 首次只走 `CreateWorkflow(script=...)`，不调用 `EvalWorkflowSnippet`；编译修复
   通过草稿 `Edit` + `CreateWorkflow(path=...)` 提交，不重复传完整脚本。
5. `/lemon 恢复 <run_id>` 先读取状态；未被取代的 stopped run 使用相同 ID 恢复，
   running/pending run 只报告进展，不创建新 run。
6. superseded、errored 或不存在的 run 不被恢复，命令返回现有工具诊断。
7. Desktop、SEA、remote staging 产物缺少任一必需资产时，构建立即失败。
8. Ponytail 与 Caveman 的 MIT 许可证进入 `THIRD-PARTY-NOTICES.md` 和 inventory。
9. 从插件命令展开的技能加载不会调用不存在的 `lemon` 技能；干净工作区的
   “审查当前改动”审查最近一次真实提交，并公开 `HEAD^` 范围；工作区有内容时
   不混入已提交的变更；显式要求未提交差异时不自动回退。
10. 只有生成文件的状态标记、无内容差异和无父提交时，报告无法审查的具体范围，
    不把空的 `git.changedFiles()` 当成“代码已审查、没有问题”。
11. 编码任务只为本来需要的规划、实现和审查 actor 写入精简 Ponytail persona；不新增
    Ponytail actor，不用完整 skill 文本膨胀每个子会话，且安全、错误处理、无障碍和要求的验证不被删除。
12. Caveman 只精简用户可见的进度和短摘要；子 actor 之间的 typed result、证据、精确错误、安全警告、
    详细报告与 artifact 不压缩。workflow 不新增 Caveman actor，不启动 proxy 或 hook。
13. 完整 Desktop staging 的隔离夹具包含仓库内 lemon 和 Computer Use；两包必需文件暂存后与源码逐字节一致，任一 CUA 必需文件缺失时拒绝而不是读取用户缓存。

## 暂存夹具修复记录（2026-10-02）

此前失败路径是临时仓库中的 `apps/lcode-cli/packages/lcode-cua-plugin/.lcode-plugin/plugin.json`；仓库自研插件本身的四项必需资源齐全。修复 `scripts/lemon-workflow-builtin.test.mjs` 的双插件输入准备，将 CUA 暂存完整性和缺失拒绝用例拆到 `scripts/computer-use-plugin-staging-cases.mjs`，由既有 `computer-use-plugin-builtin.test.mjs` 导入，原执行入口保持不变。生产 SDK、Helper 和 staging 校验未改。

实际运行 `node --import tsx --test scripts/lemon-workflow-builtin.test.mjs scripts/computer-use-plugin-builtin.test.mjs`：26/26 通过，0 skip。根 `pnpm typecheck`、`pnpm lint` 和 `pnpm architecture:check --changed` 通过；三个测试文件定向格式检查通过。测试仅用隔离目录和受控 bridge，不等同实际桌面动作、安装或发布验收。
