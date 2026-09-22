// Composed at module load from the dynamic-workflow facade so the model always
// sees the current API surface.

import { FACADE_DTS } from "@zcode/dynamic-workflow";
import { SAVED_WORKFLOW_PROJECT_DIR, WORKFLOW_DRAFTS_DIR } from "@zcode/contracts";
import { compactWorkflowFacadeForDescription } from "./workflow-description-facade.js";

const PROMPT_FACADE_DTS = compactWorkflowFacadeForDescription(FACADE_DTS);

const INTRO = [
  "Create and run a dynamic workflow: a TypeScript script, written against the facade below, that orchestrates multiple model-driven subagents with plain control flow (loops, conditionals, fan-out) and typed intermediate results.",
  "The script is typechecked first; on a clean compile the user is asked to confirm, then the run starts in the background — you will be notified with the workflow's final result (the script's top-level return value) when it settles. Compilation errors come back as diagnostics: fix the script and call the tool again.",
].join(" ");

/**
 * 三条来源。写在 WHEN_TO_USE 之前，因为「先看看有没有现成的」是模型在写第一行脚本之前就
 * 该做的判断——放在后面它已经开始写了。
 *
 * 两句「回路」紧跟其后：模型默认会把改过的
 * 脚本整段重贴，而那正是这个特性要消灭的三笔代价——两万 token 重流一遍（有的 provider 直接卡
 * 死在上面）、被 compaction 丢掉的脚本、以及为了改一行而重新生成整段。
 */
const SOURCES = [
  "Three ways to give the workflow to run — pass exactly one:",
  "- `script`: a one-off workflow you write inline, for this situation.",
  `- \`saved\`: a workflow already saved in this project (\`${SAVED_WORKFLOW_PROJECT_DIR}/\`), by name — \`saved: { name: "pr-review", args: { pr: "123" } }\`.`,
  `- \`path\`: a script file on disk, relative to the working directory or absolute — normally the file a previous result named. Pass \`args\` alongside it when the file declares them in a \`/* zcode-workflow\` block.`,
  "",
  `An inline \`script\` is saved to a file under \`${WORKFLOW_DRAFTS_DIR}/\` and the result names it, whether the script compiled or not.`,
  "After that, edit that file and resubmit with `path` instead of pasting the script again: a resubmitted 20k-token script is slow and some providers stall on it, while an edit is one small tool call.",
  "Before writing a workflow from scratch, consider ListSavedWorkflows: if the project already saved one that fits, running it beats rebuilding it — it is the version the user reviewed and kept. Saved workflows declare their own arguments; pass them in `saved.args` and they are validated against the declaration (unknown keys, missing required values and wrong types are rejected) before anything runs.",
  "Either way the user confirms the run, and the confirmation shows them the actual script that will execute.",
  // 修订的路由引导。一句话，放在来源之后：
  // 模型到这里已经知道要跑什么，接下来才轮到「这次是不是在改上一次」——而那是另一个工具的事。
  "This tool starts a NEW workflow. To change a run that already exists — fix an errored one, extend a completed one, or repair one that is still running and visibly going wrong — do not call CreateWorkflow again: call AmendWorkflow with the run's ID and the revised script. It stops a running predecessor for you, re-uses every finished result you left untouched at no token cost, and starts without another confirmation when the run is this session's own.",
].join("\n");

/**
 * 工作流只能由 `/workflow` 或明确请求发起，模型不得自行决定开一条。
 * 不能把「多子代理 + 确定性控制流」也列为适用场景——那等于给了模型一条自选入口：
 * 一次编排需求就可能在用户没开口时变成一条要确认、要跑很久的 run。
 */
const WHEN_TO_USE = [
  "When to use:",
  '- The user explicitly asks for a workflow — "use a workflow", "with a workflow", "使用 workflow", "用工作流", or any phrasing that names workflow/工作流 as the means: this tool is mandatory. Do not substitute the Agent/Task subagent tools, do not do the work inline yourself, and do not judge the task too small for a workflow — the user chose the tool, and that choice is theirs. Size only decides how many subagents the script gets, never whether it is written.',
  "- Without such an explicit request, do not start a workflow: delegate with the Agent tool or do the work yourself, even for multi-step or multi-subagent tasks.",
].join("\n");

const RULES = [
  "Authoring rules:",
  "- Plain TypeScript. Define result types with a plain `interface Foo { ... }` or `type Foo = ...` and pass them as `ask<T>` type arguments.",
  "- Compiled under `strict` (with `noUncheckedIndexedAccess` off): indexing an array or record (`items[i]`) needs no guard. `.find()`, `.match()`, `Map.get()` and optional properties still yield `T | undefined` / `null` and must be guarded before use.",
  "- Never use the `declare` modifier (`declare interface`, `declare const`, ...): the script is compiled inside a function body, where ambient declarations are illegal. (The facade block above uses `declare` because it is the host's ambient API description — do not imitate it; your script defines plain interfaces.)",
  "- No `export` statements either — the workflow's output is its final `return`.",
  "- Top-level `await` and a final `return <value>` are allowed; the returned value is exactly what you receive in the completion notification.",
  "- No `import` statements.",
  "- No Node/web APIs: `process`, `fetch`, `fs` do not exist and fail typechecking.",
  "- `world.run` executes a real command. Its first argument must be a compile-time string literal — the script's command set is shown to the user at confirmation — so interpolate runtime values into the args array, never into the command name. A nonzero exit code comes back as a value (`{ exitCode, stdout, stderr }`), not an exception: branch on `exitCode` for gate checks. Default timeout 300s; override per call with `timeoutMs` (no cap). Spawn failures and timeouts reject; stdout/stderr over 256KB each reject like any other over-cap world read.",
  // 门的强度：实盘里脚本几乎都有验证阶段，
  // 但门常比任务弱——仓库有单测与 e2e 两层时只跑单测，然后把 e2e 写进 notCovered。工具描述只
  // 带规则一句，理由与两层门的写法在 skill。
  "- Choose the gate from the repository, not from habit: before writing a `world.run` check, find the checks the project already defines (package.json scripts, a Makefile, CI, the README's verify command) and let the strongest one the request implies decide the exit. A fast unit suite may drive a loop's rounds, but the integration suite, end-to-end suite or bench that actually decides the request runs at least once before the final `return`, with the `timeoutMs` it needs. A check that exists and was skipped is not `notCovered`; it is unverified work, and the report must say so.",
  // 验证与代价成比例 + 只在下一步需要全部结果处 join：实盘里验证按形式叠加、阶段间一律 Promise.all 屏障。各一句，理由在 skill。
  "- Verify in proportion to what a wrong claim costs: findings the user will act on as fact get an independent confirmer or a deciding `world.run`; a `world.run` that already decided needs no confirmer on top; creative or subjective output gets at most one independent read; a suite the script runs as a gate is run once, by the script — say so in the asks so subagents do not each run it again.",
  "- Join with `Promise.all` only where the next step needs every item. When two stages map one to one (a reviewer per file, a confirmer per finding), chain them per item inside the fan-out callback and join once at the end, so confirmation starts as each result lands instead of after the slowest item.",
  "- Test fixed logic (parsers, glob patterns, gate predicates) with the `EvalWorkflowSnippet` tool before submitting: it runs a snippet against the same compiler and world-read path, and a passing snippet pastes into the workflow verbatim.",
  "- The workflow's final `return` is the report the main agent hands back. Return a report shape — a conclusion, findings with their evidence and whether each was confirmed, what was verified and how, what was not covered — rather than a bare array. The dynamic-workflows skill carries the interface to copy.",
  '- Publish what the user should see with `artifact.*`: a file a subagent wrote (`await artifact.file("book", "out/book.pdf", {title, primary: true})`, workspace-relative, copied at publish time, same id again = new version), a markdown you composed, or a dashboard declared once at the top (`artifact.chart("perf", {x, y})`) and fed by `report(item, "perf")`. When a run publishes more than one, mark the deliverable `primary: true` (one id per run) so the card and the run pane lead with it. Ids and the report tag are compile-time literals. Publishing rejects catchably when the file is missing or too large — that is the moment to hand the gap back to a subagent.',
  "- The final `return` stays the model-facing result; artifacts are the user-facing deliverable. Never put the same content in both.",
  "- Model-side errors never reach the script. Rate limits, concurrency limits, overload, network errors, timeouts and unknown provider errors are retried by the runtime without limit while it adapts the fan-out to what the provider accepts; a deterministic one (expired sign-in, model not in the plan, quota cap, invalid request) stops the whole run as `stopped` so the user can fix the cause and resume it — the script is never told. So do not write retry loops or `try`/`catch` for provider errors. Reserve `try`/`catch` and retry loops for logic failures — a subagent result that failed validation, a gate that did not pass, a world read over its cap, an artifact publish whose source file is missing, or a `ContextLimit` (the ask was too large for the model's context even after compaction: split the work or send less).",
  // 与上一条同源：并发是运行时的事，不是模型的调节旋钮。`max_concurrency` 的完整语义在
  // 字段描述上（contracts/tools/create-workflow.ts），这里只放一条交叉引用，免得模型把它
  // 当成 provider 限流的对策——那正是上一条刚说过运行时自己会处理的东西。
  "- How many subagents work at once is the runtime's decision, not the script's. Do not design around it, and set the `max_concurrency` field only when the user asks to limit parallelism — never in response to provider errors.",
  // 与上一条同一族：run 级的旋钮，默认不该被碰。这里唯一要说穿的是「换的是子代理，不是你」
  // ——模型读到「跑在 X 上」时最容易顺手把自己也当成换了模型，然后向用户复述一个假的当前模型。
  "- The workflow's subagents run on the session model unless the `subagent_model` field says otherwise. Set it only when the user asks for the subagents to run on a specific model; you (the main agent) stay on the session model either way. ListModels lists what this host has configured.",
  "- On diagnostics, edit the file the result names and call the tool again with `path`; never paste the script a second time.",
].join("\n");

const PHASES = [
  "Phases — required in every script, not optional:",
  '- Cover the whole script with `phase("...")` markers, one at the head of each stage, top to bottom. The confirmation graph the user approves draws one node per phase; without markers they get one card per step and no story. That graph is the user\'s entire experience of a workflow — supplying phases is part of writing one.',
  '- Name each phase for the user, in the language the user is speaking in this session: a short natural phrase saying what this stage accomplishes ("Research each changed file in parallel", "汇总并产出最终报告"). Orchestration vocabulary the user never chose — "fan-out", "gate", "aggregate" — is not a phase name; the user approves stages by what they do. Say it the way you would tell a colleague what is happening: "Check that the tests still pass" / "确认测试仍然通过", not "Gate: test verification" / "执行测试验证任务".',
  "- Mechanics: the name must be a compile-time string literal (no interpolation), and the call must be a standalone statement — the marker claims the rest of its enclosing block, nested blocks and inlined helper calls included, so a marker inside an `if` covers that branch only. Two markers with the same name are one phase, which is how a retry loop stays two nodes instead of per-round sprawl.",
  "- Every phase must contain at least one subagent `ask` or one `world.run`. A phase is a stage the user can watch progress through; plain script logic between two asks — reading `args`, shaping a prompt, building the final `return` — runs in a flash and shows no progress, so it is not a stage. Fold that logic into the phase before or after it. Do not open a phase for the setup at the top or the `return` at the bottom.",
].join("\n");

/**
 * 子代理名的命名规则。图精炼（模型事后改名的侧路调用）已撤回，图上的名字只剩脚本里的原词，
 * 所以可读性要在写脚本时一次到位——阶段名早有这条规则，这里推广到 `agent("…")`。
 */
const NAMES = [
  "Subagent names:",
  '- The confirmation graph draws one card per subagent, and the card text is the name you pass to `agent("...")`. Write it for the user, in the language the user is speaking in this session: a short concrete phrase saying what that subagent does in this script ("代码评审员", "Benchmark runner") — the way a colleague would refer to that role. A variable-style token or a number ("w1", "planner_2", "节点3", "子代理A") says nothing to the user.',
  "- A name is also an identity: it must be unique within the run, and a revised re-run matches its cached results by it. Keep names stable across revisions of the same script, and give duplicates in a loop their own computed names (see the facade).",
].join("\n");

export const CREATE_WORKFLOW_TOOL_DESCRIPTION = [
  INTRO,
  "",
  SOURCES,
  "",
  WHEN_TO_USE,
  "",
  "The script is checked against these facade declarations:",
  "```ts",
  PROMPT_FACADE_DTS,
  "```",
  "",
  RULES,
  "",
  PHASES,
  "",
  NAMES,
].join("\n");
