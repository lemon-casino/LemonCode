import assert from "node:assert/strict";
import test from "node:test";
import {
  EvalWorkflowSnippetInputJsonSchema,
  EvalWorkflowSnippetInputSchema,
} from "./eval-workflow-snippet.js";

test("snippet fields stay optional in the provider schema and execution schema", () => {
  assert.deepEqual(EvalWorkflowSnippetInputJsonSchema.required, []);
  assert.deepEqual(Object.keys(EvalWorkflowSnippetInputJsonSchema.properties as object), [
    "code",
    "path",
    "timeoutMs",
  ]);
  assert.equal(EvalWorkflowSnippetInputJsonSchema.additionalProperties, false);
  for (const input of [
    {},
    { code: "return 1;" },
    { path: "snippet.ts" },
    { code: "return 1;", path: "snippet.ts" },
  ]) {
    assert.equal(EvalWorkflowSnippetInputSchema.safeParse(input).success, true);
  }
});

test("null, empty strings, unknown fields and out-of-range timeouts are not omission", () => {
  for (const input of [
    { code: null },
    { path: null },
    { code: "" },
    { path: "" },
    { code: "return 1;", unexpected: true },
    { timeoutMs: 999 },
    { timeoutMs: 600001 },
  ]) {
    assert.equal(EvalWorkflowSnippetInputSchema.safeParse(input).success, false);
  }
  for (const timeoutMs of [1000, 60000, 600000]) {
    assert.equal(
      EvalWorkflowSnippetInputSchema.safeParse({ code: "return 1;", timeoutMs }).success,
      true,
    );
  }
});
