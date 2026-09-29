import assert from "node:assert/strict";
import test from "node:test";
import { commandPayloadSchemas } from "./command.js";

const target = { rowId: 7, entityId: "user-7" };
const modelSelection = {
  providerId: "provider-b",
  modelId: "model-b",
  options: { reasoningLevel: "high", speed: "fast" },
};

test("editUserQuery accepts a complete submitted model selection", () => {
  const result = commandPayloadSchemas.editUserQuery.safeParse({
    target,
    newText: "edited prompt",
    modelSelection,
    workspaceMode: "preserve",
  });

  assert.equal(result.success, true);
  if (result.success) assert.deepEqual(result.data.modelSelection, modelSelection);
});

test("editUserQuery remains compatible when modelSelection is omitted", () => {
  const result = commandPayloadSchemas.editUserQuery.safeParse({
    target,
    newText: "legacy edit",
  });

  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.modelSelection, undefined);
});

test("editUserQuery rejects malformed model selections", () => {
  const result = commandPayloadSchemas.editUserQuery.safeParse({
    target,
    newText: "edited prompt",
    modelSelection: { providerId: "provider-b", modelId: "model-b", options: { speed: "" } },
  });

  assert.equal(result.success, false);
});
