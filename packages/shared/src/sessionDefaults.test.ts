import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema } from "./validationAppSettings.js";
import { resolveSessionDefaults } from "./sessionDefaults.js";

const selection = {
  providerId: "api-provider",
  modelId: "model",
  options: { reasoningLevel: "low", speed: "standard" },
};

test("session defaults inherit by identity and project null restores global values", () => {
  const settings = {
    defaultSessionModelSelection: selection,
    defaultSessionApprovalMode: "edit" as const,
    projectExecutionPreferences: {
      "remote-a": { defaultSessionApprovalMode: "build" as const },
      "remote-b": { defaultSessionModelSelection: null, defaultSessionApprovalMode: null },
      "/repo": { defaultSessionModelSelection: { providerId: "oauth-provider", modelId: "other" } },
    },
  };
  assert.deepEqual(
    resolveSessionDefaults(settings, { workspacePath: "/repo", workspaceIdentity: " remote-a " }),
    { modelSelection: selection, approvalMode: "build" },
  );
  assert.deepEqual(
    resolveSessionDefaults(settings, { workspacePath: "/repo", workspaceIdentity: "remote-b" }),
    { modelSelection: selection, approvalMode: "edit" },
  );
  assert.equal(
    resolveSessionDefaults(settings, { workspacePath: "/repo" }).modelSelection?.providerId,
    "oauth-provider",
  );
  assert.deepEqual(resolveSessionDefaults({}, { workspacePath: "/repo" }), {
    modelSelection: undefined,
    approvalMode: undefined,
  });
});

test("defaults validate complete model identity and strict approval modes without changing old values", () => {
  const parsed = appSettingsSchema.parse({
    defaultSessionExecutionMode: "worktree",
    gitCommitReviewMode: "draft",
    defaultSessionModelSelection: selection,
    defaultSessionApprovalMode: "yolo",
  });
  assert.equal(parsed.defaultSessionExecutionMode, "worktree");
  assert.equal(parsed.gitCommitReviewMode, "draft");
  assert.deepEqual(parsed.defaultSessionModelSelection, selection);
  assert.equal(
    appSettingsPatchSchema.safeParse({
      projectExecutionPreferences: {
        scope: { defaultSessionModelSelection: null, defaultSessionApprovalMode: null },
      },
    }).success,
    true,
  );
  for (const value of ["plan", "auto", "unknown", true]) {
    assert.equal(
      appSettingsPatchSchema.safeParse({ defaultSessionApprovalMode: value }).success,
      false,
    );
    assert.equal(
      appSettingsPatchSchema.safeParse({
        projectExecutionPreferences: { scope: { defaultSessionApprovalMode: value } },
      }).success,
      false,
    );
  }
  assert.equal(
    appSettingsPatchSchema.safeParse({ defaultSessionModelSelection: { providerId: "p" } }).success,
    false,
  );
});
