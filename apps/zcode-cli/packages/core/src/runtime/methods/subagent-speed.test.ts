import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@zcode/contracts";
import { modelSelectionFromActiveModel } from "./subagent.js";

test("a child inheriting an active model retains its selected speed", () => {
  const model = {
    providerId: "custom",
    modelId: "example",
    options: { reasoningLevel: "high", speed: "fast" },
  } as Model;
  assert.deepEqual(modelSelectionFromActiveModel(model), {
    providerId: "custom",
    modelId: "example",
    options: { reasoningLevel: "high", speed: "fast" },
  });
});
