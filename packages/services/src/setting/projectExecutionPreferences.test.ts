import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSettingService } from "./settingService.js";
import { resolveProjectExecutionPolicy } from "@lcode/shared";

test("independent settings owners preserve concurrent project and field overrides", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-project-settings-"));
  const previous = process.env.LCODE_DESKTOP_HOME_DIR;
  process.env.LCODE_DESKTOP_HOME_DIR = directory;
  try {
    const first = createSettingService();
    const second = createSettingService();
    await Promise.all([
      first.update({ projectExecutionPreferences: { "/repo/a": { executionMode: "worktree" } } }),
      second.update({ projectExecutionPreferences: { "/repo/b": { executionMode: "local" } } }),
      first.update({
        projectExecutionPreferences: { "/repo/a": { setupCommands: ["pnpm install"] } },
      }),
      second.update({
        projectExecutionPreferences: { "/repo/a": { autoGenerateGitCommitMessage: "disabled" } },
      }),
    ]);
    const settings = await first.get();
    assert.deepEqual(settings.projectExecutionPreferences, {
      "/repo/a": {
        executionMode: "worktree",
        setupCommands: ["pnpm install"],
        autoGenerateGitCommitMessage: "disabled",
      },
      "/repo/b": { executionMode: "local" },
    });
    await second.update({
      projectExecutionPreferences: { "/repo/a": { executionMode: "inherit", setupCommands: [] } },
    });
    assert.deepEqual((await first.get()).projectExecutionPreferences?.["/repo/a"], {
      executionMode: "inherit",
      setupCommands: [],
      autoGenerateGitCommitMessage: "disabled",
    });
  } finally {
    if (previous === undefined) delete process.env.LCODE_DESKTOP_HOME_DIR;
    else process.env.LCODE_DESKTOP_HOME_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("unified review modes persist without rewriting legacy or concurrent project fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-review-mode-"));
  const previous = process.env.LCODE_DESKTOP_HOME_DIR;
  process.env.LCODE_DESKTOP_HOME_DIR = directory;
  try {
    const first = createSettingService();
    await first.update({
      autoGenerateGitCommitMessage: true,
      autoOpenGitCommitReview: false,
      projectExecutionPreferences: {
        "/repo": { executionMode: "worktree", autoGenerateGitCommitMessage: "disabled" },
      },
    });
    assert.equal(
      resolveProjectExecutionPolicy(await first.get(), { workspacePath: "/repo" })
        .gitCommitReviewMode,
      "off",
    );
    const second = createSettingService();
    await Promise.all([
      first.update({ gitCommitReviewMode: "draft-and-review" }),
      second.update({
        projectExecutionPreferences: { "/repo": { gitCommitReviewMode: "inherit" } },
      }),
      first.update({ projectExecutionPreferences: { "/other": { gitCommitReviewMode: "draft" } } }),
      second.update({
        projectExecutionPreferences: { "/repo": { validationCommands: ["pnpm lint"] } },
      }),
    ]);
    const reloaded = await createSettingService().get();
    assert.equal(reloaded.gitCommitReviewMode, "draft-and-review");
    assert.equal(reloaded.autoGenerateGitCommitMessage, true);
    assert.equal(reloaded.autoOpenGitCommitReview, false);
    assert.deepEqual(reloaded.projectExecutionPreferences?.["/repo"], {
      executionMode: "worktree",
      autoGenerateGitCommitMessage: "disabled",
      gitCommitReviewMode: "inherit",
      validationCommands: ["pnpm lint"],
    });
    assert.equal(
      resolveProjectExecutionPolicy(reloaded, { workspacePath: "/repo" }).gitCommitReviewMode,
      "draft-and-review",
    );
    assert.equal(
      resolveProjectExecutionPolicy(reloaded, { workspacePath: "/other" }).gitCommitReviewMode,
      "draft",
    );
  } finally {
    if (previous === undefined) delete process.env.LCODE_DESKTOP_HOME_DIR;
    else process.env.LCODE_DESKTOP_HOME_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
