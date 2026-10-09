import assert from "node:assert/strict";
import test from "node:test";
import { buildOnboardingRecordEntry, buildOnboardingSettingsPatch } from "./onboardingSavePatch.js";

const base = {
  occupation: "developer" as const,
  mode: "coding" as const,
  memory: true,
  suggestions: true,
  preferencesSkipped: false,
  executionEdited: false,
  executionMode: "local" as const,
  reviewMode: "off" as const,
  skippedFinalStep: false,
};

test("preferences patch keeps the onboarding answers when the page was answered", () => {
  const patch = buildOnboardingSettingsPatch(base);
  assert.equal(patch.onboardingOccupation, "developer");
  assert.equal(patch.memoryEnabled, true);
  assert.equal(patch.proactiveSuggestionsEnabled, false); // coding 模式不落推荐
});

test("skipping the preferences page falls back to conservative defaults", () => {
  const patch = buildOnboardingSettingsPatch({ ...base, preferencesSkipped: true });
  assert.equal(patch.memoryEnabled, false);
  assert.equal(patch.proactiveSuggestionsEnabled, false);
});

// 执行方式与提交审核是既有配置，不是引导专属偏好：跳过时绝不能写回默认值，
// 否则用户在设置里配好的工作树/审核模式会被静默重置。
test("execution settings are only written when the user actually chose", () => {
  assert.equal(
    buildOnboardingSettingsPatch(base).defaultSessionExecutionMode,
    undefined,
    "untouched execution settings must not be written",
  );
  const edited = buildOnboardingSettingsPatch({
    ...base,
    executionEdited: true,
    executionMode: "worktree",
    reviewMode: "draft",
  });
  assert.equal(edited.defaultSessionExecutionMode, "worktree");
  assert.equal(edited.gitCommitReviewMode, "draft");
});

test("skipping the final step never writes the execution settings", () => {
  const patch = buildOnboardingSettingsPatch({
    ...base,
    executionEdited: true,
    executionMode: "worktree",
    reviewMode: "draft-and-review",
    skippedFinalStep: true,
  });
  assert.equal(patch.defaultSessionExecutionMode, undefined);
  assert.equal(patch.gitCommitReviewMode, undefined);
});

test("record entry distinguishes a skipped page with null from an explicit choice", () => {
  const answered = buildOnboardingRecordEntry({
    occupation: "developer",
    mode: "coding",
    memory: true,
    suggestions: false,
    preferencesSkipped: false,
    completedAt: "2026-10-09T00:00:00.000Z",
  });
  assert.equal(answered.memoryEnabled, true);
  const skipped = buildOnboardingRecordEntry({
    occupation: "developer",
    mode: "coding",
    memory: true,
    suggestions: false,
    preferencesSkipped: true,
    completedAt: "2026-10-09T00:00:00.000Z",
  });
  assert.equal(skipped.memoryEnabled, null);
  assert.equal(skipped.proactiveSuggestionsEnabled, null);
});
