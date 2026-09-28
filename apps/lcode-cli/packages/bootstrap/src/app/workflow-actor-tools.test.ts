import assert from "node:assert/strict";
import test from "node:test";
import {
  AMEND_WORKFLOW_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  READ_SESSION_CONTEXT_TOOL_NAME,
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
  SESSION_HISTORY_SEARCH_TOOL_NAME,
} from "@lcode/contracts";
import { workflowActorToolPolicy } from "./workflow-actor-tools.js";

test("workflow actors cannot discover or deep-read workspace session history", () => {
  const { toolDisallowlist } = workflowActorToolPolicy();
  const disallowedTools = new Set(toolDisallowlist);

  assert.equal(
    disallowedTools.size,
    toolDisallowlist.length,
    "disallowlist must not contain duplicates",
  );

  for (const toolName of [
    SESSION_HISTORY_SEARCH_TOOL_NAME,
    READ_SESSION_CONTEXT_TOOL_NAME,
    ASK_USER_QUESTION_TOOL_NAME,
    ENTER_PLAN_MODE_TOOL_NAME,
    EXIT_PLAN_MODE_TOOL_NAME,
    CREATE_WORKFLOW_TOOL_NAME,
    AMEND_WORKFLOW_TOOL_NAME,
    RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
  ]) {
    assert.equal(disallowedTools.has(toolName), true, `${toolName} must remain disallowed`);
  }
});
