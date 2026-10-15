import assert from "node:assert/strict";
import test from "node:test";
import { resumeWorkflowRunToolEntry } from "./resume-workflow-run.js";
import type { ToolExecutionContext } from "../types.js";

test("unavailable original owner is an actionable failure without background acceptance", async () => {
  const result = await resumeWorkflowRunToolEntry.handler({ run_id: "fixture-run" }, {
    dynamicWorkflowRunPort: { resume: async () => ({ ok: false, reason: "owner_unavailable" }) },
  } as unknown as ToolExecutionContext);
  assert.equal("result" in result && result.result, false);
  assert.ok("message" in result && result.message.startsWith("workflow_run_owner_unavailable:"));
  assert.equal("backgroundTaskId" in result, false);
});
