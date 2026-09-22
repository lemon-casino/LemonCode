---
description: "使用 Ponytail + Caveman 规则，通过 ZCode dynamic workflow 完成任务"
argument-hint: "[任务描述]"
skills: lemon-workflow:dynamic-workflows, lemon-workflow:ponytail, lemon-workflow:caveman
---

把本命令当作 `/workflow` 加载 Ponytail 与 Caveman 的全局编排入口，直接执行，不要只解释规则。
`/lemon` 是命令，`lemon` 不是技能；只加载上面列出的三个 `lemon-workflow:*` 技能，不要调用 `Skill(lemon)`。

1. 使用已装配的 `ponytail` 与 `caveman` 技能。Ponytail 默认使用 `full`：先理解问题，再按 YAGNI、现有代码、标准库、原生能力、已安装依赖、最小正确实现的顺序决策；保留验证、错误处理、安全和无障碍要求。Caveman 默认使用 `full`：压缩说明和过程性文字，但保留代码、命令、路径、数字、精确错误和安全警告。不要把代码或错误压缩成含糊表达。
2. 先判断当前目标是新任务，还是明确要求继续、恢复或唤醒已有 workflow run：
   - 恢复已有 run：已有 `run_id` 时先调用 `GetWorkflowRun`；没有 `run_id` 时调用 `ListWorkflowRuns` 定位候选，再用 `GetWorkflowRun` 确认。仅 `status === "stopped"` 且 `stopReason !== "superseded"` 时才调用 `ResumeWorkflowRun(run_id)`；若 `stopReason === "provider"`，先解决供应商故障。`running` 或 `pending` 只报告当前进展，恢复成功后不要再调用 `CreateWorkflow`。superseded、errored、不存在或不可恢复的 run 使用工具诊断直接说明，不得静默新建替代 run。
   - 新任务：严格按 ZCode `/workflow` 的语义处理，使用 `dynamic-workflows` skill，决定合适的子代理拓扑，编写符合 dynamic-workflows facade 的 TypeScript workflow script，并调用 `CreateWorkflow`。用户要求 workflow 时不得改用普通 `Agent` 或直接代做；不要在子代理中嵌套 `CreateWorkflow`。
3. 用户要求修改已有 workflow 脚本或设置时，使用 `AmendWorkflow`；不要把脚本变化伪装成 `ResumeWorkflowRun`。旧片段仍在上下文时，用一次 `AmendWorkflow(run_id, edits=[{find, replace}])` 完成精确小改；旧片段不在上下文时才编辑 run 的脚本文件并传 `path`；只有整体重写才传完整 `script`。
4. 审查“当前改动”且用户没有明确指定 Git 基准时，在 workflow 的第一阶段先调用 `git.changedFiles()` 取得相对 `HEAD` 的工作区实质差异（含未跟踪文件），不得仅以 `git.status()` 的修改标记判断有可审查的内容。如果有文件，使用 `HEAD` 作为审查基准；未跟踪文件用 `files.read(path)` 获取内容。工作区没有内容差异时，先用 `git.log(2)` 确认存在父提交，再用 `git.changedFiles("HEAD^")` 审查最近一次提交，并为逐文件审查提供 `git.diff("HEAD^", path)`；明确告诉用户本次切换到了最近一次提交及其 `HEAD^` 基准。用户明确指定未提交改动、提交或其他基准时严格使用该范围，不自动回退。若选定范围无内容差异或没有父提交，直接报告具体原因，不派发审查代理；无差异不等于审查通过或没有问题。所有审查代理和最终报告必须使用同一个已宣布的比较基准。
5. Workflow 应包含面向用户的 `phase(...)` 阶段、需要分支时的 typed results、仓库已有的确定性检查，以及按 workflow 规则发布最终报告或 artifact。只添加任务真正需要的阶段，不为形式堆步骤。
6. 本次任务目标：$ARGUMENTS

若 `$ARGUMENTS` 为空，使用当前对话中用户最新的任务作为目标。

执行约束：

- 不要调用 `EvalWorkflowSnippet`。它只是可选的作者预检工具，不是运行 workflow 的步骤；本命令直接提交 workflow。
- 第一次创建并提交新 workflow 时只调用一次 `CreateWorkflow`，只传入 `script` 字段中的完整 TypeScript 脚本；不要同时传 `path`、`saved` 或其他 snippet 来源字段。不要为本命令创建临时 snippet 文件。
- 如果 `CreateWorkflow` 返回脚本诊断，编辑结果中命名的草稿文件，再用 `CreateWorkflow(path=...)` 提交；不要再次内联整份脚本，不要改用 `EvalWorkflowSnippet`，也不要重复提交同一个无效调用。
- 恢复分支只使用现有 run 的 `run_id` 调用 `ResumeWorkflowRun`。不得为“恢复”重新生成脚本或创建新的 run。
- 不要递归发送 `/workflow` 文本命令；`CreateWorkflow` 就是 `/workflow` 的实际执行入口。除非用户明确要求，否则不要启用 Caveman proxy、生命周期 hooks 或修改其他客户端的请求路由。
