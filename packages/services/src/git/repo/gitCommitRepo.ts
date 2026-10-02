import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  GitCommandProvider,
  GitCommandExecutionOptions,
} from "../providers/gitCommandProvider.js";
import {
  ensureGitCommandSucceeded,
  normalizeInputPath,
  parseStatusPorcelain,
} from "./gitCliHelpers.js";
import type { GitResolvedRepository } from "./gitCliTypes.js";

export async function commitWithGit(
  command: GitCommandProvider,
  resolution: GitResolvedRepository,
  message: string,
  paths?: string[],
  options?: { stagedOnly?: boolean },
): Promise<{ commitHash: string; warning?: string }> {
  if (!message.trim()) throw new Error("Commit message cannot be empty");
  const cwd = resolution.repoRoot;
  const run = async (args: string[], extra: Partial<GitCommandExecutionOptions> = {}) => {
    const result = await command.run({ cwd, args: ["--literal-pathspecs", ...args], ...extra });
    ensureGitCommandSucceeded("git commit", result);
    return result.stdout;
  };
  const repoPaths = paths?.length
    ? [...new Set(await Promise.all(paths.map((path) => normalizeInputPath(resolution, path))))]
    : [];
  const headResult = await command.run({ cwd, args: ["rev-parse", "--verify", "HEAD"] });
  const parent = headResult.exitCode === 0 ? headResult.stdout.trim() : null;
  let cleanupPaths = repoPaths;
  let temp: string | undefined;
  let env: NodeJS.ProcessEnv | undefined;
  let committed: { commitHash: string; warning?: string } | undefined;
  try {
    if (repoPaths.length) {
      // 中文依据：仅按 rename 新路径查询会把 Git rename 降为 added，必须从完整状态找回配对旧路径。
      const status = await run(["status", "--porcelain=v2", "-z"]);
      cleanupPaths = [
        ...new Set([
          ...repoPaths,
          ...parseStatusPorcelain(status)
            .entries.filter((entry) => repoPaths.includes(entry.path))
            .map((entry) => entry.originalPath)
            .filter((path): path is string => Boolean(path)),
        ]),
      ];
      temp = await mkdtemp(join(tmpdir(), "lcode-git-index-"));
      env = { GIT_INDEX_FILE: join(temp, "index") };
      await run(parent ? ["read-tree", parent] : ["read-tree", "--empty"], { env });
      if (options?.stagedOnly) {
        const staged = await run(["ls-files", "--stage", "-z", "--", ...repoPaths]);
        await run(["update-index", "--force-remove", "--", ...cleanupPaths], { env });
        for (const line of staged.split("\0").filter(Boolean)) {
          const entry = /^([0-7]+) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/.exec(line);
          if (!entry || entry[3] !== "0")
            throw new Error("Cannot commit selected staged paths while index conflicts exist.");
          await run(["update-index", "--add", "--cacheinfo", entry[1]!, entry[2]!, entry[4]!], {
            env,
          });
        }
      } else {
        // 中文依据：UI 先 stage 会令 expectedState 失效，也会泄漏失败候选；Host 临时 index 统一捕获所选工作树含新文件。
        await run(["add", "-A", "--", ...cleanupPaths], { env });
      }
    }
    const indexArgs = ["ls-files", "--stage", "-v", "-z"];
    const candidateEntries = await run(indexArgs, env ? { env } : {});
    const realEntries = env ? await run(indexArgs) : candidateEntries;
    const reflogAction = `lcode commit ${randomUUID()}`;
    const result = await command.run({
      cwd,
      // 中文依据：post-commit 可以继续推进 HEAD，Git 自己打印的完整 commit OID 才是本次已成功提交事实。
      args: [
        "--literal-pathspecs",
        "-c",
        "core.abbrev=no",
        "-c",
        "color.ui=false",
        "commit",
        "-m",
        message.trim(),
        ...(!env && repoPaths.length ? ["--", ...repoPaths] : []),
      ],
      env: { ...env, GIT_REFLOG_ACTION: reflogAction },
    });
    const matches = [...result.stdout.matchAll(/^\[[^\r\n]* ([0-9a-f]{40}|[0-9a-f]{64})\] /gm)];
    let commitHash = matches.at(-1)?.[1];
    if (!commitHash) {
      // 中文依据：post-commit 超时可发生在打印 summary 前；唯一 reflog action 核对本次已推进的 ref，不能把成功误报成未提交。
      try {
        const reflog = await run(["reflog", "show", "--format=%H%x00%gs", "-n", "100", "HEAD"]);
        for (const line of reflog.split("\n")) {
          const [oid, subject] = line.split("\0");
          if (!oid || !subject?.startsWith(`${reflogAction}:`)) continue;
          const parents = (await run(["show", "-s", "--format=%P", oid]))
            .trim()
            .split(" ")
            .filter(Boolean);
          if (parent ? parents[0] === parent : parents.length === 0) commitHash = oid;
        }
      } catch {
        /* 无法证实本次 ref 时仍保留命令错误，不认领其它提交。 */
      }
      if (!commitHash) {
        ensureGitCommandSucceeded("git commit", result);
        commitHash = (await run(["rev-parse", "--verify", "HEAD"])).trim();
      }
      committed = {
        commitHash,
        warning: `提交已成功，但 Git/Hook 通知未完整结束，请刷新后重新确认发布：${result.stderr.trim() || "未返回提交摘要"}`,
      };
    } else {
      committed = { commitHash };
      if (
        result.exitCode !== 0 ||
        result.timedOut ||
        result.outputTruncated ||
        result.stderr.trim()
      ) {
        committed.warning = `提交已成功，但 Git/Hook 返回警告，请重新确认发布：${result.stderr.trim() || "命令未完整结束"}`;
      }
    }
    let indexUnchanged = false;
    try {
      indexUnchanged =
        (await run(indexArgs, env ? { env } : {})) === candidateEntries &&
        (!env || (await run(indexArgs)) === realEntries);
      if (!indexUnchanged)
        committed.warning = [
          committed.warning,
          "提交已成功，但 Hook 或其它进程修改了暂存区，请重新确认发布。",
        ]
          .filter(Boolean)
          .join("\n");
    } catch {
      committed.warning ??= "提交已成功，但无法校验暂存区，请重新确认发布。";
    }
    if (env && indexUnchanged) {
      try {
        // 中文依据：使用冻结 OID 而不是可移动 HEAD；只清理本次路径，保留其它会话已暂存内容。
        await run(["reset", "--quiet", commitHash, "--", ...cleanupPaths]);
      } catch (error) {
        committed.warning = `提交已成功，但暂存区同步失败：${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return committed;
  } finally {
    // ref 已成功后的清理失败不能伪装为未提交；调用者持有 commitHash 并停止后续发布。
    if (temp)
      await rm(temp, { recursive: true, force: true }).catch((error: unknown) => {
        if (!committed) throw error;
        committed.warning ??= "提交已成功，但临时暂存区清理失败，请刷新后查看。";
      });
  }
}
