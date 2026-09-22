// Composed at module load from the snippet facade so the model always sees the
// current API surface — the same constant the compiler is fed, so the contract in
// this description can never drift from what typechecks

import { SNIPPET_FACADE_DTS } from "@zcode/dynamic-workflow";
import { compactWorkflowFacadeForDescription } from "./workflow-description-facade.js";

const PROMPT_FACADE_DTS = compactWorkflowFacadeForDescription(SNIPPET_FACADE_DTS);

const INTRO = [
  "Compile and run a small dynamic-workflow TypeScript snippet synchronously, against the same compiler, sandbox, and world-read execution path a real workflow run uses.",
  "This is the test bench for workflow authoring: verify a parse function against real command output shapes, check what a glob/grep actually returns (workspace-relative sorted paths, cap rejections), or exercise gating logic on real repository state — before composing the full workflow and submitting it with CreateWorkflow.",
  "Execution is fully ephemeral: nothing is persisted, no background task is created, and the result comes back in this tool call.",
].join(" ");

const WHEN_TO_USE = [
  "When to use:",
  "- Before authoring or revising a CreateWorkflow script: test the fixed logic (parsers, filters, glob patterns, gate predicates) piece by piece. A passing snippet pastes into the workflow verbatim.",
  "- To observe real facade semantics (paths are workspace-relative and lexicographically sorted; over-cap reads reject instead of truncating) instead of guessing them.",
  "- NOT for orchestration: there is no agent()/ask() here — that is what a real workflow run is for.",
].join("\n");

const RULES = [
  "Authoring rules:",
  "- Same language as a workflow script, minus subagents: plain TypeScript, plain `interface` declarations, top-level `await`, final `return <value>` (the returned value is serialized into the tool result).",
  "- No `agent()` or `report()` — they do not exist in the snippet facade and fail typechecking.",
  "- `world.run(cmd, args?, {timeoutMs?})` executes a real command (journal-free here, but the same driver a run uses): cmd must be a string literal, nonzero exit codes come back as values, and a snippet containing world.run asks the user for confirmation before running.",
  "- Compiled under `strict` (with `noUncheckedIndexedAccess` off): indexing needs no guard; `.find()`, `.match()` and optional properties still yield `T | undefined` / `null` and must be guarded.",
  "- No `declare` modifier, no `export`, no `import`, no Node/web APIs (`process`, `fetch`, `fs` fail typechecking).",
  "- `log(...)` messages are captured in order and returned alongside the result.",
  "- The whole snippet is bounded by a wall clock (default 60s, `timeoutMs` up to 600s). Keep the returned value small (a summary, not a dump); results over 256KB fail the call.",
  "- On diagnostics, fix the snippet and call the tool again. Nothing was executed.",
].join("\n");

export const EVAL_WORKFLOW_SNIPPET_TOOL_DESCRIPTION = [
  INTRO,
  "",
  WHEN_TO_USE,
  "",
  "The snippet is checked against these facade declarations:",
  "```ts",
  PROMPT_FACADE_DTS,
  "```",
  "",
  RULES,
].join("\n");
