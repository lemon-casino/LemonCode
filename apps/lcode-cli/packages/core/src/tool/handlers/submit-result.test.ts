import assert from "node:assert/strict";
import test from "node:test";
import { createSubmitResultToolEntry } from "./submit-result.js";
import { validateInitialModelToolInput } from "../executor/validation.js";
import { createErrorResult } from "../executor/errors.js";
import { createPermissionErrorResult } from "../executor/errors.js";
import type { ExecutableToolCall } from "../types.js";

const schema = {
  type: "object",
  additionalProperties: false,
  required: [
    "conclusion",
    "independentlyVerified",
    "markdown",
    "recommendations",
    "unverifiedOrOutOfScope",
  ],
  properties: Object.fromEntries(
    [
      "conclusion",
      "independentlyVerified",
      "markdown",
      "recommendations",
      "unverifiedOrOutOfScope",
    ].map((name) => [name, { type: "string" }]),
  ),
};

test("typed 描述列出全部必填项，schema 不变且不静默修复缺失/额外字段", () => {
  const entry = createSubmitResultToolEntry(schema);
  for (const field of schema.required) assert.ok(entry.metadata.description!.includes(field));
  assert.deepEqual((entry.inputSchema.properties as Record<string, unknown>).result, {
    description: "The structured result for this ask.",
    ...schema,
  });
  assert.equal(entry.strict, true);
  assert.ok(!createSubmitResultToolEntry().metadata.description!.includes("independentlyVerified"));
  const complete = Object.fromEntries(schema.required.map((name) => [name, "verified"]));
  assert.equal(validateInitialModelToolInput({ result: complete }, entry), undefined);
  for (const result of [{ conclusion: "summary" }, { ...complete, positioning_note: null }]) {
    const error = validateInitialModelToolInput({ result }, entry);
    assert.ok(error);
    const output = createErrorResult(
      { id: "call", name: "submit_result", input: { result } } as ExecutableToolCall,
      error,
    );
    assert.equal(output.success, false);
    assert.equal(output.turnControl, undefined);
    assert.match(output.error!.message, /missing|unexpected/);
    assert.ok(output.error!.message.length <= 500);
    assert.match(output.modelContent as string, /<tool_use_error>InputValidationError:/);
  }
});

test("普通 handler 与需原样转送的用户反馈不被参数摘要改写", () => {
  const call = { id: "call", name: "submit_result", input: {} } as ExecutableToolCall;
  assert.equal(
    createErrorResult(call, new Error("handler rejected")).error!.message,
    "handler rejected",
  );
  const feedback = "请保留原始格式\n".repeat(100);
  assert.equal(
    createPermissionErrorResult(call, feedback, {}, { preserveReasonFormatting: true }).error!
      .message,
    feedback,
  );
});
