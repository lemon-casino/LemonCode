import assert from "node:assert/strict";
import test from "node:test";
import { mintRunLineageLeaseId } from "./dynamic-workflow-run-submit.js";

test("resume of the same run mints a distinct lineage lease owner", () => {
  const runId = "run-resumed-incarnation";

  const original = mintRunLineageLeaseId(runId);
  const resumed = mintRunLineageLeaseId(runId);

  assert.match(original, /^run-resumed-incarnation:/);
  assert.match(resumed, /^run-resumed-incarnation:/);
  assert.notEqual(resumed, original);
});
