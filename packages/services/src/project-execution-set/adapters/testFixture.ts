import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktreeService, type WorktreeGitPort } from "../../worktree/node.js";
export async function executionSetFixture(t: { after(action: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "lcode-execution-set-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git: WorktreeGitPort = {
    run: async (params) =>
      new Promise((resolve, reject) => {
        const env = Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
        );
        const child = spawn("git", params.args, {
          cwd: params.cwd,
          env: {
            ...env,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: join(root, "empty-config"),
            ...params.env,
          },
          windowsHide: true,
          stdio: "pipe",
        });
        let stdout = "",
          stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.once("error", reject);
        child.once("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
        child.stdin.end(params.stdin);
      }),
  };
  const command = async (cwd: string, ...args: string[]) => {
    const result = await git.run({ cwd, args });
    assert.equal(result.exitCode, 0, result.stderr);
    return result.stdout.trim();
  };
  const repositories: string[] = [];
  for (const name of ["frontend", "backend"]) {
    await command(root, "init", "--initial-branch=main", name);
    const repo = join(root, name);
    repositories.push(repo);
    await command(repo, "config", "user.name", "Execution Set Fixture");
    await command(repo, "config", "user.email", "fixture@example.invalid");
    await writeFile(join(repo, "index.txt"), name);
    await command(repo, "add", ".");
    await command(repo, "commit", "-m", "baseline");
  }
  const options = { dataDir: join(root, "worktrees"), git };
  return { root, repositories, command, options, worktrees: createWorktreeService(options) };
}
