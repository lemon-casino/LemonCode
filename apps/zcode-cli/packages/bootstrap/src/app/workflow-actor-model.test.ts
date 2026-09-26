import assert from "node:assert/strict";
import test from "node:test";
import type { ModelSelection } from "@zcode/shared/model-selection";
import {
  workflowActorExecutionFailoverScope,
  workflowActorModelPolicy,
  type WorkflowActorModelProvenance,
} from "./workflow-actor-model.js";

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
  const policy = workflowActorModelPolicy({
    runSelection: run,
    scriptSelection: script,
    approvedSelection: approved,
  });
  assert.deepEqual(policy.configOverrides.modelSelection, approved);
  assert.equal(policy.provenance, "approvedActorOverride");
});

test("script actor model wins over the workflow launch snapshot", () => {
  const policy = workflowActorModelPolicy({
    runSelection: run,
    scriptSelection: script,
  });
  assert.deepEqual(policy.configOverrides.modelSelection, script);
  assert.equal(policy.provenance, "scriptActorModel");
});

test("workflow launch snapshot keeps reasoning and speed", () => {
  const policy = workflowActorModelPolicy({ runSelection: run });
  assert.deepEqual(policy.configOverrides.modelSelection, run);
  assert.equal(policy.provenance, "runModel");
});

test("a resumePin binding retains its complete reasoning and speed selection", () => {
  const pinned = {
    ...session,
    options: { reasoningLevel: "high", speed: "fast" },
  } as ModelSelection;
  const policy = workflowActorModelPolicy(
    {},
    {
      resolvedModel: `selection:${JSON.stringify(pinned)}`,
      modelProvenance: "resumePin",
    },
  );
  assert.deepEqual(policy.configOverrides.modelSelection, pinned);
  assert.equal(policy.provenance, "resumePin");
});

test("an imported session-inherited seed starts on the parent's current selection", () => {
  const continued = {
    ...session,
    options: { reasoningLevel: "high", speed: "fast" },
  } as ModelSelection;
  const policy = workflowActorModelPolicy({}, undefined, {
    resolvedModel: `selection:${JSON.stringify(continued)}`,
    modelProvenance: "sessionInherited",
  });

  assert.deepEqual(policy.configOverrides, {});
  assert.equal(policy.provenance, "sessionInherited");
});

test("a same-run resume pin stays fixed even when an imported seed is also present", () => {
  const resumed = { ...session, options: { reasoningLevel: "high" } } as ModelSelection;
  const imported = { ...run, options: { reasoningLevel: "low" } } as ModelSelection;
  const policy = workflowActorModelPolicy(
    {},
    {
      resolvedModel: `selection:${JSON.stringify(resumed)}`,
      modelProvenance: "resumePin",
    },
    {
      resolvedModel: `selection:${JSON.stringify(imported)}`,
      modelProvenance: "sessionInherited",
    },
  );

  assert.deepEqual(policy.configOverrides.modelSelection, resumed);
  assert.equal(policy.provenance, "resumePin");
});

test("a same-run binding stays ahead of an explicit session-inheritance launch marker", () => {
  const continued = { ...session, options: { reasoningLevel: "high" } } as ModelSelection;
  const policy = workflowActorModelPolicy(
    { runProvenance: "sessionInherited" },
    {
      resolvedModel: `selection:${JSON.stringify(continued)}`,
      modelProvenance: "sessionInherited",
    },
    {
      resolvedModel: `selection:${JSON.stringify(run)}`,
      modelProvenance: "runModel",
    },
  );

  assert.deepEqual(policy.configOverrides.modelSelection, continued);
  assert.equal(policy.provenance, "sessionInherited");
});

test("a cold-resumed session-inherited actor continues from its journal selection without becoming pinned", () => {
  const continued = {
    ...session,
    options: { reasoningLevel: "high", speed: "fast" },
  } as ModelSelection;
  const policy = workflowActorModelPolicy(
    {},
    {
      resolvedModel: `selection:${JSON.stringify(continued)}`,
      modelProvenance: "sessionInherited",
    },
  );

  assert.deepEqual(policy.configOverrides.modelSelection, continued);
  assert.equal(policy.provenance, "sessionInherited");
});

test("a legacy actor row without provenance is inherited unless explicit configuration proves otherwise", () => {
  const continued = {
    ...session,
    options: { reasoningLevel: "high", speed: "fast" },
  } as ModelSelection;
  const legacyBinding = { resolvedModel: `selection:${JSON.stringify(continued)}` };

  const inherited = workflowActorModelPolicy({}, legacyBinding);
  assert.deepEqual(inherited.configOverrides.modelSelection, continued);
  assert.equal(inherited.provenance, "sessionInherited");

  const reconstructed = workflowActorModelPolicy({ scriptSelection: script }, legacyBinding);
  assert.deepEqual(reconstructed.configOverrides.modelSelection, script);
  assert.equal(reconstructed.provenance, "scriptActorModel");
});

test("an imported fixed seed preserves both its selection and provenance", () => {
  const policy = workflowActorModelPolicy({}, undefined, {
    resolvedModel: `selection:${JSON.stringify(run)}`,
    modelProvenance: "resumePin",
  });

  assert.deepEqual(policy.configOverrides.modelSelection, run);
  assert.equal(policy.provenance, "resumePin");
});

test("persisted selection JSON rejects options outside the shared ModelSelection schema", () => {
  assert.throws(
    () =>
      workflowActorModelPolicy(
        {},
        {
          resolvedModel:
            'selection:{"providerId":"provider-a","modelId":"model-a","options":{"speed":1}}',
          modelProvenance: "resumePin",
        },
      ),
    /Cannot construct the model pinned for this subagent/u,
  );
  assert.throws(
    () =>
      workflowActorModelPolicy(
        {},
        {
          resolvedModel:
            'selection:{"providerId":"provider-a","modelId":"model-a","options":{"privateCache":"opaque"}}',
          modelProvenance: "resumePin",
        },
      ),
    /Cannot construct the model pinned for this subagent/u,
  );
});

test("only an actor without workflow or resume model constraints inherits the session", () => {
  const policy = workflowActorModelPolicy({});

  assert.deepEqual(policy.configOverrides, {});
  assert.equal(policy.provenance, "sessionInherited");
});

test("only session-inherited actors receive an exact execution failover scope", () => {
  const explicitSources: WorkflowActorModelProvenance[] = [
    "approvedActorOverride",
    "scriptActorModel",
    "runModel",
    "resumePin",
  ];
  for (const provenance of explicitSources) {
    assert.equal(
      workflowActorExecutionFailoverScope({
        childSessionId: "sess_dwf-run-actor",
        foregroundExecutionId: "foreground-1",
        provenance,
      }),
      undefined,
    );
  }

  assert.deepEqual(
    workflowActorExecutionFailoverScope({
      childSessionId: "sess_dwf-run-actor",
      foregroundExecutionId: "foreground-1",
      provenance: "sessionInherited",
    }),
    {
      backgroundWorkId: "sess_dwf-run-actor",
      foregroundExecutionId: "foreground-1",
    },
  );
  assert.equal(
    workflowActorExecutionFailoverScope({
      childSessionId: "sess_dwf-run-actor",
      provenance: "sessionInherited",
    }),
    undefined,
  );
});
