import assert from "node:assert/strict";
import test from "node:test";
import { serializeWorkflowArtifact as sharedSerialize } from "@lcode/shared/lcode-protocol-v4";
import {
  boundDynamicWorkflowRunEventPayload,
  DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS as limits,
  serializeWorkflowArtifact,
} from "./dynamic-workflow-run.port.js";

test("workflow payload bounding keeps JSON shape and non-finite number normalization", () => {
  const result = boundDynamicWorkflowRunEventPayload({
    finite: 2,
    infinite: Infinity,
    notANumber: NaN,
    missing: undefined,
    items: [undefined, () => undefined, Symbol("test"), 1n, "kept"],
  });
  assert.deepEqual(result, {
    payload: {
      finite: 2,
      infinite: null,
      notANumber: null,
      items: [null, null, null, null, "kept"],
    },
    truncated: false,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result.payload)), result.payload);
});

test("workflow payload bounding preserves string, array, key and depth limits", () => {
  const boundaryText = "x".repeat(limits.maxStringLength);
  assert.deepEqual(boundDynamicWorkflowRunEventPayload({ text: boundaryText }), {
    payload: { text: boundaryText },
    truncated: false,
  });
  // 截断点落在代理对中间时，保留旧契约：宁可少一个码元，也不制造孤立高代理项。
  const surrogateText = "x".repeat(limits.maxStringLength - 1) + "\u{1f600}";
  const text = boundDynamicWorkflowRunEventPayload({ text: surrogateText });
  assert.equal(text.payload.text, "x".repeat(limits.maxStringLength - 1));
  assert.equal(text.truncated, true);
  const array = boundDynamicWorkflowRunEventPayload({
    items: Array.from({ length: limits.maxArrayItems + 1 }, (_, i) => i),
  });
  assert.equal((array.payload.items as number[]).length, limits.maxArrayItems);
  assert.equal(array.truncated, true);
  const keys = boundDynamicWorkflowRunEventPayload(
    Object.fromEntries(Array.from({ length: limits.maxKeys + 1 }, (_, i) => [`key${i}`, i])),
  );
  assert.equal(Object.keys(keys.payload).length, limits.maxKeys);
  assert.equal(keys.truncated, true);
  let nested: Record<string, unknown> = { value: "leaf" };
  for (let depth = 0; depth < limits.maxDepth; depth += 1) nested = { child: nested };
  const bounded = boundDynamicWorkflowRunEventPayload(nested);
  assert.equal(bounded.truncated, true);
  assert.deepEqual(JSON.parse(JSON.stringify(bounded.payload)), bounded.payload);
});

test("workflow payload bounding stays pure, cycle-bounded and publicly re-exported", () => {
  const input = { nested: { values: [1, 2] } };
  const result = boundDynamicWorkflowRunEventPayload(input);
  assert.deepEqual(result.payload, input);
  assert.notEqual(result.payload, input);
  assert.notEqual(result.payload.nested, input.nested);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(boundDynamicWorkflowRunEventPayload(cyclic).truncated, true);
  assert.equal(serializeWorkflowArtifact, sharedSerialize);
  assert.equal(boundDynamicWorkflowRunEventPayload.length, 1);
});
