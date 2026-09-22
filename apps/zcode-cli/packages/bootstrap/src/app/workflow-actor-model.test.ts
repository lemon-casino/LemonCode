import assert from "node:assert/strict";
import test from "node:test";
import type { ModelSelection } from "@zcode/shared/model-selection";
import { workflowActorModelPolicy } from "./workflow-actor-model.js";

const session: ModelSelection = {
  providerId: "session-provider",
  modelId: "session-model",
  options: { reasoningLevel: "medium", speed: "standard" },
};
const run: ModelSelection = {
  providerId: "run-provider",
  modelId: "run-model",
  options: { reasoningLevel: "low", speed: "fast" },
};
const script: ModelSelection = {
  providerId: "script-provider",
  modelId: "script-model",
  options: { reasoningLevel: "high", speed: "standard" },
};
const approved: ModelSelection = {
  providerId: "approved-provider",
  modelId: "approved-model",
  options: { reasoningLevel: "max", speed: "fast" },
};

test("approved actor model wins over script and launch defaults without losing options", () => {
  assert.deepEqual(
    workflowActorModelPolicy({
      parentSelection: session,
      runSelection: run,
      scriptSelection: script,
      approvedSelection: approved,
    }).configOverrides.modelSelection,
    approved,
  );
});

test("script actor model wins over the workflow launch snapshot", () => {
  assert.deepEqual(
    workflowActorModelPolicy({
      parentSelection: session,
      runSelection: run,
      scriptSelection: script,
    }).configOverrides.modelSelection,
    script,
  );
});

test("workflow launch snapshot keeps reasoning and speed", () => {
  assert.deepEqual(
    workflowActorModelPolicy({ parentSelection: session, runSelection: run }).configOverrides
      .modelSelection,
    run,
  );
});

test("a resumed actor retains pinned reasoning and speed even if the session uses the same model", () => {
  const pinned = { ...session, options: { reasoningLevel: "high", speed: "fast" } } as ModelSelection;
  const changedSession = { ...session, options: { reasoningLevel: "low", speed: "standard" } } as ModelSelection;
  assert.deepEqual(
    workflowActorModelPolicy(
      { parentSelection: changedSession },
      `selection:${JSON.stringify(pinned)}`,
    ).configOverrides.modelSelection,
    pinned,
  );
});
