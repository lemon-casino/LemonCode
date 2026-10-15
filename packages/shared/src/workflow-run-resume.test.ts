import assert from "node:assert/strict";
import test from "node:test";
import { workflowRunResumeRejectionReasonSchema } from "./workflow-run-resume.js";

test("original owner refusal is a validated resume reason while unknown wire values stay rejected", () => {
  assert.equal(
    workflowRunResumeRejectionReasonSchema.parse("owner_unavailable"),
    "owner_unavailable",
  );
  for (const invalid of [null, undefined, 1, "owner_forced", "", { reason: "owner_unavailable" }])
    assert.equal(workflowRunResumeRejectionReasonSchema.safeParse(invalid).success, false);
});
