import { open, writeFile } from "node:fs/promises";
import type { GitCommandProvider } from "../providers/gitCommandProvider.js";
import { ensureGitCommandSucceeded } from "./gitCliHelpers.js";

const MAX_MESSAGE_BYTES = 1_048_576;

export async function runCommitReviewHook(
  command: GitCommandProvider,
  cwd: string,
  index: string,
  name: string,
  args: string[] = [],
) {
  // 中文依据：仅检查 Hook 文件存在会误拦 Husky 占位脚本；原生入口负责 hooksPath、可执行性及退出码。
  const result = await command.run({
    cwd,
    args: ["hook", "run", "--ignore-missing", name, ...(args.length ? ["--", ...args] : [])],
    env: { GIT_INDEX_FILE: index, GIT_EDITOR: ":" },
    maxOutputBytes: MAX_MESSAGE_BYTES,
  });
  ensureGitCommandSucceeded(`提交 Hook ${name}`, result);
}

async function readMessage(path: string) {
  const file = await open(path, "r");
  try {
    if (!(await file.stat()).isFile()) throw new Error("Hook 提交消息文件不是普通文件。");
    const buffer = Buffer.alloc(MAX_MESSAGE_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const { bytesRead } = await file.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!bytesRead) break;
      bytes += bytesRead;
    }
    if (bytes > MAX_MESSAGE_BYTES) throw new Error("Hook 提交消息内容超限。");
    const content = buffer.subarray(0, bytes);
    const message = content.toString("utf8");
    if (message.includes("\0") || !Buffer.from(message).equals(content))
      throw new Error("Hook 提交消息必须为 UTF-8 文本。");
    return message;
  } finally {
    await file.close();
  }
}

export async function prepareCommitReviewMessage(
  command: GitCommandProvider,
  cwd: string,
  index: string,
  tree: string,
  path: string,
  message: string,
  assertCurrent: () => Promise<void>,
) {
  const assertUnchanged = async () => {
    const result = await command.run({ cwd, args: ["write-tree"], env: { GIT_INDEX_FILE: index } });
    ensureGitCommandSucceeded("git review Hook tree", result);
    if (result.stdout.trim() !== tree)
      throw new Error("Hook 已修改冻结提交补丁，请重新审核后提交。");
    await assertCurrent();
  };
  await runCommitReviewHook(command, cwd, index, "pre-commit");
  await assertUnchanged();
  await writeFile(path, `${message.trim()}\n`);
  for (const [name, args] of [
    ["prepare-commit-msg", [path, "message"]],
    ["commit-msg", [path]],
  ] as const) {
    await runCommitReviewHook(command, cwd, index, name, [...args]);
    // 中文依据：Hook 可验证冻结补丁，但不能把格式化或其它会话的未审核内容偷偷带进提交。
    await assertUnchanged();
  }
  const cleaned = await command.run({
    cwd,
    args: ["stripspace"],
    stdin: await readMessage(path),
    maxOutputBytes: MAX_MESSAGE_BYTES,
  });
  ensureGitCommandSucceeded("git review message", cleaned);
  if (!cleaned.stdout.trim()) throw new Error("Hook 处理后的提交消息为空，请填写并重新提交。");
  await writeFile(path, cleaned.stdout);
}
