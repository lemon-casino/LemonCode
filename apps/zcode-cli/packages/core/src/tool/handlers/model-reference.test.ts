import assert from "node:assert/strict";
import test from "node:test";
import type { ModelCatalogEntry } from "@zcode/contracts";
import { parseWorkflowSubagentModel, resolveModelReference } from "./model-reference.js";

const entry: ModelCatalogEntry = {
  providerId: "custom",
  modelId: "example",
  reasoningLevels: ["low", "high"],
  defaultReasoningLevel: "high",
  defaultSpeed: "standard",
  current: false,
};

test("workflow model references keep their reasoning and receive catalog default speed", () => {
  const resolved = resolveModelReference("custom/example$low", [entry]);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const selection = parseWorkflowSubagentModel(resolved.canonical, {
    listModels: () => [entry],
  });
  assert.deepEqual(selection, {
    providerId: "custom",
    modelId: "example",
    options: { reasoningLevel: "low", speed: "standard" },
  });
});
