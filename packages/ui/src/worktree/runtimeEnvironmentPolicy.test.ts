import assert from "node:assert/strict";
import test from "node:test";
import {
  executionIntentSchema,
  projectExecutionPreferenceSchema,
  resolveProjectExecutionPolicy,
} from "@lcode/shared";

test("项目策略缺省继承本机，只有显式 managed 写进新首发 intent", () => {
  const scope = { workspacePath: "/repo", workspaceIdentity: "remote-a" };
  const legacy = resolveProjectExecutionPolicy({}, scope);
  assert.equal(legacy.environmentPreference, "inherit");
  assert.equal(legacy.environmentPolicy, "local");
  const preference = projectExecutionPreferenceSchema.parse({
    executionMode: "worktree",
    environmentPolicy: "managed",
  });
  const policy = resolveProjectExecutionPolicy(
    { projectExecutionPreferences: { "remote-a": preference } },
    scope,
  );
  assert.equal(policy.environmentPreference, "managed");
  const intent = executionIntentSchema.parse({
    mode: policy.executionMode,
    environmentPolicy: policy.environmentPolicy,
  });
  assert.equal(intent.environmentPolicy, "managed");
  assert.equal(
    resolveProjectExecutionPolicy(
      { projectExecutionPreferences: { "remote-a": preference } },
      { ...scope, workspaceIdentity: "remote-b" },
    ).environmentPolicy,
    "local",
  );
  assert.equal(
    projectExecutionPreferenceSchema.safeParse({ environmentPolicy: "automatic-managed" }).success,
    false,
  );
});
