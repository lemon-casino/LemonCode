import assert from "node:assert/strict";
import test from "node:test";
import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { buildRegistryModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import {
  initialWorkflowRunSettingsDraft,
  workflowRunSettingsChange,
} from "./workflowRunSettings.js";

const inherited = {
  providerId: "provider-a",
  modelId: "model-a",
  options: { reasoningLevel: "high", speed: "fast" },
};
const run = {
  runId: "run-a",
  status: "running",
  lastEventSequence: 1,
  usage: { spentTokens: 0, nodesUsed: 0 },
  actors: [],
  nodes: [],
  subagentSelection: inherited,
  sessionSelection: inherited,
} as WorkflowRunState;

test("inherited workflow choice is visible without an explicit override", () => {
  assert.deepEqual(initialWorkflowRunSettingsDraft(run).model, { kind: "session" });
  const initial = initialWorkflowRunSettingsDraft(run);
  assert.deepEqual(
    workflowRunSettingsChange(
      initial,
      {
        ...initial,
        model: {
          kind: "model",
          selection: { ...inherited, options: { ...inherited.options, speed: "standard" } },
        },
      },
      undefined,
    ),
    { subagentSelection: { ...inherited, options: { ...inherited.options, speed: "standard" } } },
  );
});

test("resetting an explicit workflow selection sends inheritance reset", () => {
  const initial = initialWorkflowRunSettingsDraft({
    ...run,
    subagentModel: "provider-a/model-a",
    subagentSelection: { ...inherited, options: { ...inherited.options, speed: "standard" } },
  });
  assert.deepEqual(
    workflowRunSettingsChange(initial, { ...initial, model: { kind: "session" } }, undefined),
    { subagentSelection: null },
  );
});

test("workflow model picker lists models across configured suppliers", () => {
  const view = {
    providers: [
      {
        providerId: "supplier-a",
        providerName: "Supplier A",
        config: { api: { type: "openai" } },
        models: [{ modelId: "model-a", config: { properties: {} } }],
      },
      {
        providerId: "supplier-b",
        providerName: "Supplier B",
        config: { api: { type: "anthropic" } },
        models: [{ modelId: "model-b", config: { properties: {} } }],
      },
    ],
  } as unknown as ModelSelectionView;
  const groups = buildRegistryModelSelectGroups(ZCODE_AGENT_PROVIDER, view);
  assert.deepEqual(
    groups.map((group) => group.label),
    ["Supplier A", "Supplier B"],
  );
  assert.deepEqual(
    groups.map((group) => group.items[0]?.name),
    ["model-a", "model-b"],
  );
});
