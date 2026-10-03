import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktreeService } from "./node.js";
import type { WorktreeGitPort } from "./node.js";

export async function fixture(t: { after: (action: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "lcode-worktree-test-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const git: WorktreeGitPort = {
    run: (params) =>
      new Promise((resolve, reject) => {
        const env = Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
        );
        Object.assign(env, {
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: join(root, "empty-config"),
          ...params.env,
        });
        const child = spawn("git", params.args, {
          cwd: params.cwd,
          env,
          windowsHide: true,
          stdio: "pipe",
        });
        let stdout = "",
          stderr = "";
        child.stdout.setEncoding("utf8").on("data", (value: string) => {
          stdout += value;
        });
        child.stderr.setEncoding("utf8").on("data", (value: string) => {
          stderr += value;
        });
        child.once("error", reject);
        child.once("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
        child.stdin.end(params.stdin);
      }),
  };
  async function command(cwd: string, ...args: string[]) {
    const result = await git.run({ cwd, args });
    assert.equal(result.exitCode, 0, result.stderr);
    return result.stdout.trim();
  }
  await command(root, "init", "--initial-branch=main", "repo");
  const repo = join(root, "repo");
  await command(repo, "config", "user.name", "Worktree Fixture");
  await command(repo, "config", "user.email", "fixture@example.invalid");
  await writeFile(join(repo, "file.txt"), "baseline\n");
  await command(repo, "add", "file.txt");
  await command(repo, "commit", "-m", "baseline");
  const options = { dataDir: join(root, "managed"), git };
  return { root, repo, command, options, service: createWorktreeService(options) };
}
