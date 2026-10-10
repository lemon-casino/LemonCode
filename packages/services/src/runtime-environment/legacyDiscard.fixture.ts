import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TestContext } from "node:test";
import type { WorktreeGitPort } from "../worktree/node.js";

/** 通过公开 Git port 组装临时仓库；不跨模块引用 Worktree 的私有测试实现。 */
export async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "lcode-legacy-discard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git: WorktreeGitPort = {
    run: async (params) => {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
      );
      Object.assign(env, {
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(root, "empty-config"),
        ...params.env,
      });
      try {
        const result = await promisify(execFile)("git", params.args, {
          cwd: params.cwd,
          env,
          windowsHide: true,
          maxBuffer: 16 * 1024 * 1024,
        });
        return { ...result, exitCode: 0 };
      } catch (error) {
        const result = error as { code?: number; stdout?: string; stderr?: string };
        return {
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          exitCode: Number(result.code) || 1,
        };
      }
    },
  };
  const command = async (cwd: string, ...args: string[]) => {
    const result = await git.run({ cwd, args });
    assert.equal(result.exitCode, 0, result.stderr);
    return result.stdout.trim();
  };
  await command(root, "init", "--initial-branch=main", "repo");
  const repo = join(root, "repo");
  await command(repo, "config", "user.name", "Fixture");
  await command(repo, "config", "user.email", "fixture@example.invalid");
  await writeFile(join(repo, "file.txt"), "baseline\n");
  await command(repo, "add", ".");
  await command(repo, "commit", "-m", "baseline");
  return { root, repo, command, options: { dataDir: join(root, "managed"), git } };
}
