import { gitDeleteBranchRequestSchema } from "@lcode/shared";
import assert from "node:assert/strict";
import { test } from "node:test";
import { deleteLocalBranch } from "./gitBranchDeletion.js";
import type { GitCommandProvider } from "../providers/gitCommandProvider.js";

function fixture(options: { checkedOutPath?: string; hash?: string; unmerged?: boolean } = {}) {
  const commands: string[][] = [];
  const provider = {
    run: async ({ args }: { args: string[] }) => {
      commands.push(args);
      if (args[0] === "for-each-ref")
        return {
          exitCode: 0,
          stdout: `${options.hash ?? "a".repeat(40)}\0${options.checkedOutPath ?? ""}\n`,
          stderr: "",
        };
      if (args[0] === "merge-base")
        return { exitCode: options.unmerged ? 1 : 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  } as unknown as GitCommandProvider;
  return { commands, provider };
}
test("删除确认以真实 ref 版本和 worktree 占用作为门禁", async () => {
  for (const [options, code] of [
    [{ checkedOutPath: "/other/worktree" }, "in-use"],
    [{ hash: "b".repeat(40) }, "changed"],
    [{ unmerged: true }, "unmerged"],
  ] as const) {
    const { provider, commands } = fixture(options);
    const result = await deleteLocalBranch(provider, "/repo", "lcode/task-中文", "a".repeat(40));
    assert.deepEqual(result, { ok: false, code });
    assert.equal(
      commands.some((args) => args[0] === "branch"),
      false,
    );
  }
});
test("已合并中文分支使用安全 argv 删除，不强制、不切换", async () => {
  const { provider, commands } = fixture();
  assert.deepEqual(await deleteLocalBranch(provider, "/repo", "lcode/task-中文", "a".repeat(40)), {
    ok: true,
  });
  assert.deepEqual(commands.at(-1), ["branch", "-d", "--", "lcode/task-中文"]);
});
test("非法输入在任何 Git IO 之前拒绝", async () => {
  const { provider, commands } = fixture();
  assert.deepEqual(await deleteLocalBranch(provider, "/repo", "--help", "wrong"), {
    ok: false,
    code: "invalid",
  });
  assert.equal(commands.length, 0);
});

test("删除请求拒绝 force 和缺少确认版本的形状", () => {
  const input = {
    workspacePath: "/repo",
    branchName: "feature",
    expectedCommitHash: "a".repeat(40),
  };
  assert.equal(gitDeleteBranchRequestSchema.safeParse(input).success, true);
  assert.equal(gitDeleteBranchRequestSchema.safeParse({ ...input, force: true }).success, false);
  assert.equal(
    gitDeleteBranchRequestSchema.safeParse({ ...input, expectedCommitHash: undefined }).success,
    false,
  );
});
