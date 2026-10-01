import type { GitCommandProvider } from "../providers/gitCommandProvider.js";

export async function assertCommitReviewPolicy(command: GitCommandProvider, cwd: string) {
  const signing = await command.run({ cwd, args: ["config", "--bool", "--get", "commit.gpgsign"] });
  if ((signing.exitCode !== 0 && signing.exitCode !== 1) || signing.timedOut)
    throw new Error("无法检查仓库提交签名策略。");
  if (signing.stdout.trim() === "true")
    throw new Error("此仓库要求签名，请使用原手动提交入口；审核提交不会绕过签名。");
}
