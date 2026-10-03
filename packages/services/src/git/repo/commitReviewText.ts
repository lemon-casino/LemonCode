import type {
  GitCommandExecutionOptions,
  GitCommandProvider,
} from "../providers/gitCommandProvider.js";

export async function readCommitReviewHead(
  command: GitCommandProvider,
  cwd: string,
): Promise<string | null> {
  const result = await command.run({ cwd, args: ["rev-parse", "--verify", "HEAD"] });
  if (result.exitCode === 0) return result.stdout.trim();
  // 未初始化提交与 Git 执行失败必须区分，不能把任意错误当作空 HEAD。
  const unborn = await command.run({ cwd, args: ["symbolic-ref", "-q", "HEAD"] });
  if (unborn.exitCode !== 0 || result.timedOut) throw new Error("无法读取 Git HEAD。");
  const exists = await command.run({
    cwd,
    args: ["show-ref", "--verify", "--quiet", unborn.stdout.trim()],
  });
  if (exists.exitCode !== 1 || exists.timedOut) throw new Error("无法读取 Git HEAD。");
  return null;
}

export function parseCommitReviewTreeEntries(raw: string) {
  return new Map(
    raw
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf("\t");
        const [mode, type, oid] = line.slice(0, tab).split(" ");
        if (type !== "blob" || (mode !== "100644" && mode !== "100755"))
          throw new Error("提交审核仅支持普通文本文件，不支持符号链接或子模块。");
        return [line.slice(tab + 1), { mode: mode!, oid: oid! }] as const;
      }),
  );
}

export async function readCommitReviewText(
  git: (args: string[], options?: Partial<GitCommandExecutionOptions>) => Promise<string>,
  oid: string,
): Promise<string> {
  const content = await git(["cat-file", "blob", oid], { maxOutputBytes: 1_048_576 });
  if (
    content.includes("\0") ||
    (await git(["hash-object", "--stdin"], { stdin: content })).trim() !== oid
  ) {
    throw new Error("提交审核仅支持可完整读取的 UTF-8 文本，二进制不能按行拆分。");
  }
  return content;
}
