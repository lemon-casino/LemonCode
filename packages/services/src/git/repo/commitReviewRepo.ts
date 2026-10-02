import { createHash } from "node:crypto";
import { copyFile, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
  GitCommandProvider,
  GitCommandExecutionOptions,
} from "../providers/gitCommandProvider.js";
import type { CommitReviewContent } from "../commitReviewPlanner.js";
import type { GitRepositorySummary, GitFileMutationJournal } from "@lcode/shared";
import { describeCommitReviewFiles } from "./commitReviewDiff.js";
import { assertCommitReviewPolicy } from "./commitReviewPolicy.js";
import { prepareCommitReviewMessage } from "./commitReviewHooks.js";
import {
  finishCommitReviewTransaction,
  publishCommitReviewRef,
} from "./commitReviewTransaction.js";
import { canonicalizeCommitReviewJournal } from "./commitReviewJournal.js";
import { batchGitPathspecs } from "./gitPathspecBatches.js";
import { readCommitReviewWorktree } from "./commitReviewWorktree.js";
import type { GitCliRepo, GitResolvedRepository } from "./gitCliTypes.js";
import {
  normalizeInputPath,
  ensureRepositoryAvailable,
  ensureGitCommandSucceeded,
} from "./gitCliHelpers.js";

const MAX_TEXT_BYTES = 1_048_576;
const MAX_REVIEW_BYTES = 2_097_152;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export interface CommitReviewSnapshot {
  worktreeVersion: string;
  hasModeChanges: boolean;
  summary: GitRepositorySummary;
  resolution: GitResolvedRepository;
  head: string | null;
  ref: string;
  paths: string[];
  includeUnstaged: boolean;
  version: string;
  files: CommitReviewContent[];
}

export class CommitReviewRepo {
  constructor(
    private readonly repo: GitCliRepo,
    private readonly command: GitCommandProvider,
  ) {}

  private async git(
    cwd: string,
    args: string[],
    options: Partial<GitCommandExecutionOptions> = {},
  ) {
    const result = await this.command.run({
      cwd,
      args: ["--literal-pathspecs", ...args],
      maxOutputBytes: MAX_REVIEW_BYTES,
      ...options,
    });
    ensureGitCommandSucceeded("git commit review", result);
    if (result.outputTruncated) throw new Error("提交审核内容超限，请缩小文件范围。");
    return result.stdout;
  }

  private async head(cwd: string): Promise<string | null> {
    const result = await this.command.run({ cwd, args: ["rev-parse", "--verify", "HEAD"] });
    if (result.exitCode === 0) return result.stdout.trim();
    // 未初始化提交与 Git 执行失败必须区分，不能把任意错误当作空 HEAD。
    const unborn = await this.command.run({ cwd, args: ["symbolic-ref", "-q", "HEAD"] });
    if (unborn.exitCode !== 0 || result.timedOut) throw new Error("无法读取 Git HEAD。");
    const exists = await this.command.run({
      cwd,
      args: ["show-ref", "--verify", "--quiet", unborn.stdout.trim()],
    });
    if (exists.exitCode !== 1 || exists.timedOut) throw new Error("无法读取 Git HEAD。");
    return null;
  }

  private async gitPaths(
    cwd: string,
    args: string[],
    paths: string[],
    options: Partial<GitCommandExecutionOptions> = {},
  ) {
    const outputs: string[] = [];
    for (const batch of batchGitPathspecs(paths))
      outputs.push(await this.git(cwd, [...args, "--", ...batch], options));
    return outputs.join("");
  }

  private async ref(cwd: string): Promise<string> {
    const result = await this.command.run({ cwd, args: ["symbolic-ref", "-q", "HEAD"] });
    if (result.exitCode === 0) return result.stdout.trim();
    if (result.exitCode === 1) return "HEAD";
    throw new Error("无法读取 Git 分支引用。");
  }

  private async treeEntries(cwd: string, tree: string, paths: string[]) {
    const raw = await this.gitPaths(cwd, ["ls-tree", "-r", "-z", tree], paths);
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

  private async text(cwd: string, oid: string): Promise<string> {
    const content = await this.git(cwd, ["cat-file", "blob", oid], {
      maxOutputBytes: MAX_TEXT_BYTES,
    });
    if (
      content.includes("\0") ||
      (await this.git(cwd, ["hash-object", "--stdin"], { stdin: content })).trim() !== oid
    ) {
      throw new Error("提交审核仅支持可完整读取的 UTF-8 文本，二进制不能按行拆分。");
    }
    return content;
  }

  private async indexPath(cwd: string) {
    const path = (await this.git(cwd, ["rev-parse", "--git-path", "index"])).trim();
    return isAbsolute(path) ? path : resolve(cwd, path);
  }

  private async writeIndexEntry(cwd: string, index: string, file: CommitReviewContent) {
    const env = { GIT_INDEX_FILE: index };
    if (file.content === null) {
      await this.git(cwd, ["update-index", "--force-remove", "--", file.path], { env });
    } else {
      const oid = (
        await this.git(cwd, ["hash-object", "-w", "--stdin"], { stdin: file.content })
      ).trim();
      await this.git(cwd, ["update-index", "--add", "--cacheinfo", file.mode, oid, file.path], {
        env,
      });
    }
  }

  private async selectedTree(
    cwd: string,
    paths: string[],
    head: string | null,
    includeUnstaged: boolean,
  ): Promise<string> {
    const temp = await mkdtemp(join(tmpdir(), "lcode-review-index-"));
    try {
      const index = join(temp, "index");
      const env = { GIT_INDEX_FILE: index };
      await this.git(cwd, head ? ["read-tree", head] : ["read-tree", "--empty"], { env });
      if (includeUnstaged) {
        await this.gitPaths(cwd, ["add", "-A"], paths, { env });
      } else {
        const staged = await this.gitPaths(cwd, ["ls-files", "--stage", "-z"], paths);
        await this.gitPaths(cwd, ["update-index", "--force-remove"], paths, { env });
        for (const line of staged.split("\0").filter(Boolean)) {
          const tab = line.indexOf("\t");
          const [mode, oid, stage] = line.slice(0, tab).split(" ");
          if (stage !== "0") throw new Error("冲突文件不能自动审核提交。");
          await this.git(
            cwd,
            ["update-index", "--add", "--cacheinfo", mode!, oid!, line.slice(tab + 1)],
            { env },
          );
        }
      }
      return (await this.git(cwd, ["write-tree"], { env })).trim();
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }

  private async version(resolution: GitResolvedRepository, paths: string[]) {
    const cwd = resolution.repoRoot;
    const [head, ref, staged, status] = await Promise.all([
      this.head(cwd),
      this.ref(cwd),
      this.gitPaths(cwd, ["ls-files", "--stage", "-z"], paths),
      this.gitPaths(cwd, ["status", "--porcelain=v2", "-z"], paths),
    ]);
    const contents = await readCommitReviewWorktree(cwd, paths, MAX_TEXT_BYTES);
    return {
      head,
      ref,
      version: digest(JSON.stringify([head, ref, staged, status, contents])),
      worktreeVersion: digest(JSON.stringify(contents)),
    };
  }

  async capture(
    workspacePath: string,
    inputPaths: string[],
    includeUnstaged: boolean,
  ): Promise<CommitReviewSnapshot> {
    // 中文依据：文件数不能阻止纪要/审核；只拒绝空范围，内容安全校验仍单独执行。
    if (inputPaths.length === 0) throw new Error("请为提交审核选择至少一个文件。");
    this.repo.invalidate(workspacePath);
    const status = await this.repo.getStatus(workspacePath);
    const resolution = ensureRepositoryAvailable(status.resolution, "commit review");
    const paths = [
      ...new Set(await Promise.all(inputPaths.map((path) => normalizeInputPath(resolution, path)))),
    ].sort();
    for (const entry of status.entries) {
      if (!paths.includes(entry.path)) continue;
      if (entry.isConflicted) throw new Error("冲突文件需要先人工解决。");
      if (entry.originalPath) paths.push(entry.originalPath);
    }
    const cwd = resolution.repoRoot;
    const before = await this.version(resolution, paths);
    const head = await this.head(cwd);
    const ref = await this.ref(cwd);
    const tree = await this.selectedTree(cwd, paths, head, includeUnstaged);
    const base = head ?? (await this.git(cwd, ["mktree"], { stdin: "" })).trim();
    const [oldEntries, newEntries] = await Promise.all([
      this.treeEntries(cwd, base, paths),
      this.treeEntries(cwd, tree, paths),
    ]);
    const files: CommitReviewContent[] = [];
    let hasModeChanges = false;
    let bytes = 0;
    for (const path of [...new Set([...oldEntries.keys(), ...newEntries.keys()])].sort()) {
      const old = oldEntries.get(path),
        next = newEntries.get(path);
      if (old?.oid === next?.oid && old?.mode === next?.mode) continue;
      if (old && next && old.mode !== next.mode) hasModeChanges = true;
      const [headContent, content] = await Promise.all([
        old ? this.text(cwd, old.oid) : null,
        next ? this.text(cwd, next.oid) : null,
      ]);
      bytes += Buffer.byteLength(headContent ?? "") + Buffer.byteLength(content ?? "");
      if (bytes > MAX_REVIEW_BYTES) throw new Error("提交审核内容超限，请缩小文件范围。");
      files.push({
        path,
        headContent,
        content,
        mode: next?.mode ?? old!.mode,
        headMode: old?.mode ?? null,
      });
    }
    if (files.length === 0) throw new Error("没有可审核提交的文件改动。");
    if (before.version !== (await this.version(resolution, paths)).version)
      throw new Error("捕获审核快照时 Git 发生变化，请重新审核。");
    return {
      summary: status.summary,
      resolution,
      head,
      ref,
      paths,
      includeUnstaged,
      version: before.version,
      worktreeVersion: before.worktreeVersion,
      hasModeChanges,
      files,
    };
  }

  async describe(files: readonly CommitReviewContent[]) {
    return describeCommitReviewFiles(this.command, files);
  }

  async canonicalizeJournal(
    snapshot: CommitReviewSnapshot,
    journal: GitFileMutationJournal,
  ): Promise<GitFileMutationJournal> {
    const cwd = snapshot.resolution.repoRoot;
    return canonicalizeCommitReviewJournal(
      journal,
      snapshot.paths,
      (args, options) => this.git(cwd, args, options),
      (oid) => this.text(cwd, oid),
    );
  }

  async assertCurrent(snapshot: CommitReviewSnapshot) {
    if (snapshot.version !== (await this.version(snapshot.resolution, snapshot.paths)).version)
      throw new Error("Git 内容、暂存区或 HEAD 已变化，请重新审核后提交。");
  }

  async commit(
    snapshot: CommitReviewSnapshot,
    files: readonly CommitReviewContent[],
    message: string,
  ): Promise<{ commitHash: string; warning?: string }> {
    if (
      !message.trim() ||
      files.length === 0 ||
      files.some((file) => !snapshot.paths.includes(file.path))
    )
      throw new Error("非法审核提交候选。");
    const cwd = snapshot.resolution.repoRoot;
    await assertCommitReviewPolicy(this.command, cwd);
    const indexPath = await this.indexPath(cwd);
    const lockPath = `${indexPath}.lock`;
    const lock = await open(lockPath, "wx");
    let temp: string | undefined;
    let committed = false;
    let closed = false;
    try {
      temp = await mkdtemp(join(tmpdir(), "lcode-reviewed-commit-"));
      await this.assertCurrent(snapshot);
      const candidateIndex = join(temp, "candidate-index"),
        realIndex = join(temp, "real-index");
      await this.git(cwd, snapshot.head ? ["read-tree", snapshot.head] : ["read-tree", "--empty"], {
        env: { GIT_INDEX_FILE: candidateIndex },
      });
      try {
        await copyFile(indexPath, realIndex);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await this.git(cwd, ["read-tree", "--empty"], { env: { GIT_INDEX_FILE: realIndex } });
      }
      for (const file of files) {
        await this.writeIndexEntry(cwd, candidateIndex, file);
        const raw = await this.git(cwd, ["ls-files", "--stage", "-z", "--", file.path]);
        const record = raw.split("\0").find(Boolean);
        const oid = record?.split(" ")[1];
        const staged = oid ? await this.text(cwd, oid) : null;
        let nextStaged = staged;
        if (staged === file.headContent) nextStaged = file.content;
        else if (
          staged !== file.content &&
          staged !== snapshot.files.find((item) => item.path === file.path)?.content
        ) {
          if (staged === null || file.headContent === null || file.content === null)
            throw new Error("暂存补丁与拆分提交冲突，请人工审阅。");
          const current = join(temp, "staged"),
            base = join(temp, "base"),
            next = join(temp, "next");
          await Promise.all([
            writeFile(current, staged),
            writeFile(base, file.headContent),
            writeFile(next, file.content),
          ]);
          const merged = await this.command.run({
            cwd,
            args: ["merge-file", "-p", current, base, next],
            maxOutputBytes: MAX_TEXT_BYTES,
          });
          if (merged.exitCode !== 0 || merged.outputTruncated)
            throw new Error("暂存补丁与拆分提交冲突，请人工审阅。");
          nextStaged = merged.stdout;
        }
        await this.writeIndexEntry(cwd, realIndex, { ...file, content: nextStaged });
      }
      const tree = (
        await this.git(cwd, ["write-tree"], { env: { GIT_INDEX_FILE: candidateIndex } })
      ).trim();
      const messagePath = join(temp, "commit-message");
      await prepareCommitReviewMessage(
        this.command,
        cwd,
        candidateIndex,
        tree,
        messagePath,
        message,
        () => this.assertCurrent(snapshot),
      );
      await lock.writeFile(await readFile(realIndex));
      await lock.sync();
      await lock.close();
      closed = true;
      await this.assertCurrent(snapshot);
      const commitHash = (
        await this.git(cwd, [
          "commit-tree",
          tree,
          ...(snapshot.head ? ["-p", snapshot.head] : []),
          "-F",
          messagePath,
        ])
      ).trim();
      // 中文依据：临时 index 冻结候选，真实 index 锁阻止并发 stage/checkout；ref CAS 拒绝其它窗口推进 HEAD。
      let warning = await publishCommitReviewRef(
        this.command,
        cwd,
        candidateIndex,
        snapshot.ref,
        commitHash,
        snapshot.head,
      );
      committed = true;
      warning = await finishCommitReviewTransaction(
        this.command,
        cwd,
        candidateIndex,
        lockPath,
        indexPath,
        warning,
      );
      snapshot.head = commitHash;
      try {
        const nextVersion = await this.version(snapshot.resolution, snapshot.paths);
        if (
          nextVersion.head !== commitHash ||
          nextVersion.ref !== snapshot.ref ||
          nextVersion.worktreeVersion !== snapshot.worktreeVersion
        )
          throw new Error("工作树或引用在提交后发生变化");
        snapshot.version = nextVersion.version;
      } catch {
        warning ??= "提交已成功，但无法更新审核快照，请刷新并重新审核剩余改动。";
      }
      if (warning) snapshot.version = "invalid";
      this.repo.invalidate(snapshot.resolution.workspacePath);
      return { commitHash, ...(warning ? { warning } : {}) };
    } finally {
      if (!closed) await lock.close();
      if (!committed) await rm(lockPath, { force: true });
      // ref CAS 成功后不能把临时文件清理错误伪装成提交失败，否则重试会重复提交。
      if (temp) await rm(temp, { recursive: true, force: true }).catch(() => {});
    }
  }
}
