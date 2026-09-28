// AmendWorkflow 的工具描述。
// 与 CreateWorkflow 分开成文：facade 与写作规则那一大段模型已经在 CreateWorkflow 上读过，
// 这里只说修订**特有**的几件事——什么时候用、缓存怎么命中、哪些东西省略即沿用、确认窗何时出现。

export const AMEND_WORKFLOW_TOOL_DESCRIPTION = [
  "Revise any existing workflow run. A new run supersedes it and imports finished work as cache, so unchanged asks cost no model tokens. A running predecessor is stopped by this tool; do not stop or wait for it first.",
  "",
  "Revised script source — provide at most one:",
  "- `edits`: preferred for a small change whose old text is in context. Send ordered `{find, replace}` entries; each `find` must match the stored predecessor script exactly once. The batch is atomic and writes a new draft, leaving the predecessor file unchanged.",
  "- `path`: edit the script file named by the run result and pass its path when the old fragment is not in context.",
  "- `script`: send the whole script only for a genuine rewrite.",
  "- Omit all three to keep the script byte-identical and change only settings. An `edits` batch whose final script is unchanged is refused.",
  "",
  "Omitted settings inherit the predecessor. `max_concurrency: null` removes its limit; `subagent_model: null` returns to the session model. Set either only when the user asks.",
  "",
  "Cache identity is the stable named agent plus byte-identical ask order. Changed/new asks run live. After the first live workspace write or world.run, stale world-dependent cache entries run live too; answer-only entries may still replay.",
  "",
  "Missing/ambiguous edits and compile errors fail before the predecessor is touched. This session's own run can be amended without another confirmation; other ownership states follow the existing confirmation policy. Use ResumeWorkflowRun, not AmendWorkflow, to continue a stopped run unchanged. The successor notifies on completion; do not poll it.",
].join("\n");
