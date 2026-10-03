import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema } from "./validationAppSettings.js";
import { resolveGlobalGitCommitReviewMode } from "./worktreePolicy.js";

test("automatic git commit message generation defaults off and accepts an explicit patch", () => {
  assert.equal(appSettingsSchema.parse({}).autoGenerateGitCommitMessage, false);
  assert.deepEqual(appSettingsPatchSchema.parse({ autoGenerateGitCommitMessage: true }), {
    autoGenerateGitCommitMessage: true,
  });
});

test("review modes are strict, optional for migration, and default effectively off", () => {
  const empty = appSettingsSchema.parse({});
  assert.equal(empty.gitCommitReviewMode, undefined);
  assert.equal(resolveGlobalGitCommitReviewMode(empty), "off");
  for (const mode of ["off", "draft", "draft-and-review"] as const) {
    const patch = { gitCommitReviewMode: mode };
    assert.deepEqual(appSettingsPatchSchema.parse(patch), patch);
    assert.equal(resolveGlobalGitCommitReviewMode(appSettingsSchema.parse(patch)), mode);
    assert.deepEqual(
      appSettingsPatchSchema.parse({ projectExecutionPreferences: { "/project": patch } })
        .projectExecutionPreferences?.["/project"],
      patch,
    );
  }
  assert.equal(
    appSettingsPatchSchema.safeParse({
      projectExecutionPreferences: { "/project": { gitCommitReviewMode: "inherit" } },
    }).success,
    true,
  );
  for (const invalid of ["inherit", "enabled", "automatic", true])
    assert.equal(appSettingsPatchSchema.safeParse({ gitCommitReviewMode: invalid }).success, false);
  assert.equal(
    appSettingsPatchSchema.safeParse({
      projectExecutionPreferences: { "/project": { gitCommitReviewMode: "enabled" } },
    }).success,
    false,
  );
});
