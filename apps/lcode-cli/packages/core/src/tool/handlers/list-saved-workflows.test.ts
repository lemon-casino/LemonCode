import assert from "node:assert/strict";
import test from "node:test";
import { listSavedWorkflowsToolEntry } from "./list-saved-workflows.js";

function format(output: unknown) {
  const formatter = listSavedWorkflowsToolEntry.formatModelContent;
  assert.ok(formatter);
  const result = formatter(output);
  assert.equal(typeof result, "string");
  return result as string;
}

test("empty saved-template lookup distinguishes archives from drafts and run history", () => {
  for (const output of [{ workflows: [] }, { workflows: [], invalid: [] }]) {
    const result = format(output);
    assert.match(result, /count="0"/);
    assert.match(result, /project or global archive/);
    assert.match(result, /drafts and run history/);
    assert.match(result, /does not automatically save/);
    assert.doesNotMatch(result, /No workflows are saved in this project yet/);
  }
});

test("unreadable saved definitions are not formatted as an empty archive", () => {
  const result = format({
    workflows: [],
    invalid: [{ path: "/workspace/.lcode/workflows/broken.dwf.ts", reason: "Missing metadata" }],
  });
  assert.match(result, /<invalid path=/);
  assert.match(result, /Missing metadata/);
  assert.doesNotMatch(result, /No reusable workflow templates/);
});
