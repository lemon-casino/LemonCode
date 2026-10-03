import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSettingService } from "./settingService.js";

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
