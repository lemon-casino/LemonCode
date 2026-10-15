import assert from "node:assert/strict";
import test from "node:test";
import { synthesizeWorkflowSchemas } from "./synthesize.js";

test("report undefined includes field path, source location and optional-property guidance", () => {
  const result = synthesizeWorkflowSchemas("report({ baseline: undefined });");
  assert.equal(result.diagnostics.length, 1);
  const diagnostic = result.diagnostics[0]!;
  assert.equal(diagnostic.line, 1);
  assert.ok(diagnostic.column > 0);
  assert.match(diagnostic.message, /\$\.baseline/);
  assert.match(diagnostic.message, /optional property/);
  assert.match(diagnostic.message, /omit/);
});

for (const [name, script] of [
  ["omitted optional", "const row: { baseline?: number } = {}; report(row);"],
  ["present optional", "const row: { baseline?: number } = { baseline: 1 }; report(row);"],
  [
    "declared nullable",
    "const row: { baseline: number | null } = { baseline: null }; report(row);",
  ],
] as const)
  test(`report accepts ${name} without weakening serialization`, () => {
    assert.deepEqual(synthesizeWorkflowSchemas(script).diagnostics, []);
  });
