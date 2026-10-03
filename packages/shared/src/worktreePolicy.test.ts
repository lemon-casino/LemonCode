import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema } from "./validationAppSettings.js";
import {
  resolveGlobalGitCommitReviewMode,
  resolveProjectExecutionPolicy,
} from "./worktreePolicy.js";

test("old settings preserve local execution and existing review behavior", () => {
  const settings = appSettingsSchema.parse({ autoGenerateGitCommitMessage: true });
  const policy = resolveProjectExecutionPolicy(settings, { workspacePath: "/project" });
  assert.equal(policy.executionMode, "local");
  assert.equal(policy.gitCommitReviewMode, "draft-and-review");
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
  assert.deepEqual([policy.executionMode, policy.gitCommitReviewMode], ["local", "off"]);
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
      .gitCommitReviewMode,
    "off",
  );
});

test("legacy global combinations and project half overrides keep their effective behavior", () => {
  for (const generation of [false, true]) {
    for (const opening of [false, true]) {
      for (const projectGeneration of ["inherit", "enabled", "disabled"] as const) {
        for (const projectOpening of ["inherit", "enabled", "disabled"] as const) {
          const settings = appSettingsSchema.parse({
            autoGenerateGitCommitMessage: generation,
            autoOpenGitCommitReview: opening,
            projectExecutionPreferences: {
              "/project": {
                autoGenerateGitCommitMessage: projectGeneration,
                autoOpenGitCommitReview: projectOpening,
              },
            },
          });
          const saved = structuredClone(settings);
          const enabled =
            projectGeneration === "inherit" ? generation : projectGeneration === "enabled";
          const opens = projectOpening === "inherit" ? opening : projectOpening === "enabled";
          const expected = !enabled ? "off" : opens ? "draft-and-review" : "draft";
          assert.equal(
            resolveProjectExecutionPolicy(settings, { workspacePath: "/project" })
              .gitCommitReviewMode,
            expected,
          );
          assert.deepEqual(settings, saved);
        }
      }
    }
  }
  // 旧默认生成关闭、弹窗开启，不能先归并为 off 再丢掉项目只启用生成时继承的弹窗值。
  const legacy = appSettingsSchema.parse({
    projectExecutionPreferences: { "/project": { autoGenerateGitCommitMessage: "enabled" } },
  });
  assert.equal(
    resolveProjectExecutionPolicy(legacy, { workspacePath: "/project" }).gitCommitReviewMode,
    "draft-and-review",
  );
});

test("new modes override legacy flags and explicit project inherit clears legacy overrides", () => {
  const settings = appSettingsSchema.parse({
    gitCommitReviewMode: "draft",
    autoGenerateGitCommitMessage: false,
    autoOpenGitCommitReview: true,
    projectExecutionPreferences: {
      "/project": {
        gitCommitReviewMode: "inherit",
        autoGenerateGitCommitMessage: "disabled",
        autoOpenGitCommitReview: "enabled",
      },
      "remote-a": { gitCommitReviewMode: "draft-and-review" },
      "remote-b": { gitCommitReviewMode: "off" },
    },
  });
  assert.equal(resolveGlobalGitCommitReviewMode(settings), "draft");
  const inherited = resolveProjectExecutionPolicy(settings, { workspacePath: "/project" });
  assert.equal(inherited.gitCommitReviewMode, "draft");
  assert.equal(inherited.gitCommitReviewPreference, "inherit");
  assert.equal(inherited.sources.gitCommitReviewMode, "global");
  assert.equal(
    resolveProjectExecutionPolicy(settings, {
      workspacePath: "/project",
      workspaceIdentity: " remote-a ",
    }).gitCommitReviewMode,
    "draft-and-review",
  );
  assert.equal(
    resolveProjectExecutionPolicy(settings, {
      workspacePath: "/project",
      workspaceIdentity: "remote-b",
    }).gitCommitReviewMode,
    "off",
  );
  settings.gitCommitReviewMode = "off";
  assert.equal(
    resolveProjectExecutionPolicy(settings, { workspacePath: "/project" }).gitCommitReviewMode,
    "off",
  );
  assert.equal(
    resolveProjectExecutionPolicy(settings, {
      workspacePath: "/project",
      workspaceIdentity: "remote-a",
    }).gitCommitReviewMode,
    "draft-and-review",
  );
});

test("untouched legacy half overrides continue inheriting changes to the new global mode", () => {
  const settings = appSettingsSchema.parse({
    gitCommitReviewMode: "draft-and-review",
    projectExecutionPreferences: { "/project": { autoOpenGitCommitReview: "disabled" } },
  });
  const resolve = () => resolveProjectExecutionPolicy(settings, { workspacePath: "/project" });
  assert.equal(resolve().gitCommitReviewMode, "draft");
  assert.equal(resolve().gitCommitReviewPreference, "draft");
  assert.equal(resolve().sources.gitCommitReviewMode, "project");
  settings.gitCommitReviewMode = "off";
  assert.equal(resolve().gitCommitReviewMode, "off");
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
