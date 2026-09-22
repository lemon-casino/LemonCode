import assert from "node:assert/strict";
import test from "node:test";
import { FACADE_DTS, SNIPPET_FACADE_DTS } from "@zcode/dynamic-workflow";
import { AMEND_WORKFLOW_TOOL_DESCRIPTION } from "./amend-workflow-description.js";
import { CREATE_WORKFLOW_TOOL_DESCRIPTION } from "./create-workflow-description.js";
import { EVAL_WORKFLOW_SNIPPET_TOOL_DESCRIPTION } from "./eval-workflow-snippet-description.js";
import { SAVE_WORKFLOW_TOOL_DESCRIPTION } from "./save-workflow-description.js";
import { compactWorkflowFacadeForDescription } from "./workflow-description-facade.js";

test("prompt facade keeps declarations while dropping compiler documentation", () => {
  const compact = compactWorkflowFacadeForDescription(FACADE_DTS);

  assert.match(compact, /declare function agent/u);
  assert.match(compact, /declare const world/u);
  assert.match(compact, /declare const artifact/u);
  assert.doesNotMatch(compact, /\/\*\*/u);
  assert.ok(compact.length < FACADE_DTS.length / 2);
  assert.ok(
    compactWorkflowFacadeForDescription(SNIPPET_FACADE_DTS).length < SNIPPET_FACADE_DTS.length / 2,
  );
});

test("workflow tool descriptions stay within their prompt budgets", () => {
  assert.ok(CREATE_WORKFLOW_TOOL_DESCRIPTION.length <= 15_000);
  assert.ok(AMEND_WORKFLOW_TOOL_DESCRIPTION.length <= 3_000);
  assert.ok(SAVE_WORKFLOW_TOOL_DESCRIPTION.length <= 8_000);
  assert.ok(EVAL_WORKFLOW_SNIPPET_TOOL_DESCRIPTION.length <= 6_000);
});
