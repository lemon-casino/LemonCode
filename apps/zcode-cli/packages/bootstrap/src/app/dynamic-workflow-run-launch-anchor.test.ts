import assert from "node:assert/strict";
import test from "node:test";
import type { JournalStorePort, RunEvent } from "@zcode/dynamic-workflow";
import {
  readRunActorModelConfiguration,
  runRevisionModelConfigurationFromLaunch,
} from "./dynamic-workflow-run-launch-anchor.js";
import { workflowActorModelPolicy } from "./workflow-actor-model.js";

const sessionSelection = {
  providerId: "session-provider",
  modelId: "session-model",
  options: { reasoningLevel: "high" },
};
const runSelection = {
  providerId: "run-provider",
  modelId: "run-model",
  options: { reasoningLevel: "medium", speed: "fast" },
};

test("session launch snapshot remains inherited model provenance", () => {
  const configuration = readRunActorModelConfiguration(
    journalWithLaunch({
      type: "run-launched",
      inputId: "input-1",
      sessionSelection,
      subagentSelection: sessionSelection,
    }),
    "run-1",
  );

  assert.equal(configuration.defaultSelection, undefined);
});

test("explicit session inheritance survives journal replay and clears an imported run-model seed", () => {
  const configuration = readRunActorModelConfiguration(
    journalWithLaunch({
      type: "run-launched",
      inputId: "input-cleared",
      subagentModelProvenance: "sessionInherited",
      sessionSelection,
      subagentSelection: sessionSelection,
    }),
    "run-cleared",
  );

  assert.equal(configuration.defaultProvenance, "sessionInherited");
  const policy = workflowActorModelPolicy(
    { runProvenance: configuration.defaultProvenance },
    undefined,
    {
      resolvedModel: `selection:${JSON.stringify(runSelection)}`,
      modelProvenance: "runModel",
    },
  );
  assert.deepEqual(policy.configOverrides, {});
  assert.equal(policy.provenance, "sessionInherited");
});

test("legacy inherited launch does not invent an explicit clear marker", () => {
  const configuration = readRunActorModelConfiguration(
    journalWithLaunch({
      type: "run-launched",
      inputId: "input-legacy",
      sessionSelection,
      subagentSelection: sessionSelection,
    }),
    "run-legacy",
  );

  assert.equal(configuration.defaultProvenance, undefined);
});

test("explicit workflow selection remains run model provenance", () => {
  const configuration = readRunActorModelConfiguration(
    journalWithLaunch({
      type: "run-launched",
      inputId: "input-1",
      sessionSelection,
      subagentModel: "run-provider/run-model$medium",
      subagentSelection: runSelection,
    }),
    "run-1",
  );

  assert.deepEqual(configuration.defaultSelection, runSelection);
});

test("ask revision preserves session inherited model provenance", () => {
  assert.deepEqual(
    runRevisionModelConfigurationFromLaunch({
      sessionSelection,
      subagentSelection: sessionSelection,
    }),
    { sessionModelSelection: sessionSelection },
  );
});

test("ask revision preserves explicit run model provenance", () => {
  assert.deepEqual(
    runRevisionModelConfigurationFromLaunch({
      sessionSelection,
      subagentModel: "run-provider/run-model$medium",
      subagentSelection: runSelection,
    }),
    {
      sessionModelSelection: sessionSelection,
      subagentModel: runSelection,
    },
  );
});

test("ask revision restores old explicit run model strings", () => {
  assert.deepEqual(
    runRevisionModelConfigurationFromLaunch({
      subagentModel: "run-provider/run-model$medium",
    }),
    {
      subagentModel: {
        providerId: "run-provider",
        modelId: "run-model",
        options: { reasoningLevel: "medium" },
      },
    },
  );
});

function journalWithLaunch(event: RunEvent): JournalStorePort {
  return {
    listEvents: () => [{ event, sequence: 1 }],
  } as unknown as JournalStorePort;
}
