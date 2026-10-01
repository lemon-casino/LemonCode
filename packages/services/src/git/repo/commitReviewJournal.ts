import type { GitFileMutationJournal } from "@lcode/shared";
import type { GitCommandExecutionOptions } from "../providers/gitCommandProvider.js";

export async function canonicalizeCommitReviewJournal(
  journal: GitFileMutationJournal,
  paths: string[],
  git: (args: string[], options?: Partial<GitCommandExecutionOptions>) => Promise<string>,
  text: (oid: string) => Promise<string>,
): Promise<GitFileMutationJournal> {
  const attrs = (await git(["check-attr", "-z", "filter", "--", ...paths])).split("\0");
  for (let index = 2; index < attrs.length; index += 3) {
    if (attrs[index] !== "unspecified" && attrs[index] !== "unset")
      return { complete: false, mutations: [] };
  }
  const mutations: GitFileMutationJournal["mutations"] = [];
  for (const mutation of journal.mutations) {
    if (!paths.includes(mutation.path)) continue;
    const canonical = async (content: string | null) =>
      content === null
        ? null
        : text(
            (
              await git(["hash-object", "-w", `--path=${mutation.path}`, "--stdin"], {
                stdin: content,
              })
            ).trim(),
          );
    // checkpoint 是工作区原文，HEAD 是 Git clean 后的文本；用同一内置 Git 换行规则锚定版本。
    // 外部 clean filter 不具备稳定的逐次归属语义，保守合并，不替用户猜测。
    mutations.push({
      ...mutation,
      beforeContent: await canonical(mutation.beforeContent),
      afterContent: await canonical(mutation.afterContent),
    });
  }
  return { ...journal, mutations };
}
