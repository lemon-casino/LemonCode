import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema } from "./validationAppSettings.js";
import { resolveProjectExecutionPolicy } from "./worktreePolicy.js";

test("old settings preserve local execution and existing review behavior", () => {
  const settings = appSettingsSchema.parse({ autoGenerateGitCommitMessage: true });
  const policy = resolveProjectExecutionPolicy(settings, { workspacePath: "/project" });
  assert.equal(policy.executionMode, "local");
  assert.equal(policy.autoGenerateGitCommitMessage, true);
  assert.equal(policy.autoOpenGitCommitReview, true);
});

test("project overrides are independent and a draft override does not mutate settings", () => {
  const settings = appSettingsSchema.parse({
    autoGenerateGitCommitMessage: true,
    projectExecutionPreferences: {
      "/project": {
        executionMode: "worktree",
        autoGenerateGitCommitMessage: "disabled",
        autoOpenGitCommitReview: "disabled",
      },
    },
  });
  const saved = structuredClone(settings);
  const policy = resolveProjectExecutionPolicy(settings, { workspacePath: "/project" }, "local");
  assert.deepEqual(
    [policy.executionMode, policy.autoGenerateGitCommitMessage, policy.autoOpenGitCommitReview],
    ["local", false, false],
  );
  assert.equal(policy.sources.executionMode, "session");
  assert.deepEqual(settings, saved);
});

test("remote identities never inherit another host's same-path project override", () => {
  const settings = appSettingsSchema.parse({
    projectExecutionPreferences: {
      "host-a": { executionMode: "worktree" },
      "/same": { autoGenerateGitCommitMessage: "enabled" },
    },
  });
  assert.equal(
    resolveProjectExecutionPolicy(settings, {
      workspacePath: "/same",
      workspaceIdentity: " host-a ",
    }).executionMode,
    "worktree",
  );
  assert.equal(
    resolveProjectExecutionPolicy(settings, { workspacePath: "/same", workspaceIdentity: "host-b" })
      .autoGenerateGitCommitMessage,
    false,
  );
});

test("settings patches retain inheritance and reject malformed project policies", () => {
  const patch = {
    projectExecutionPreferences: {
      "/project": { executionMode: "inherit", autoOpenGitCommitReview: "enabled" },
    },
  };
  assert.deepEqual(appSettingsPatchSchema.parse(patch), patch);
  assert.equal(
    appSettingsPatchSchema.safeParse({ defaultSessionExecutionMode: "inherit" }).success,
    false,
  );
  assert.equal(
    appSettingsPatchSchema.safeParse({
      projectExecutionPreferences: { "/project": { autoGenerateGitCommitMessage: true } },
    }).success,
    false,
  );
});
