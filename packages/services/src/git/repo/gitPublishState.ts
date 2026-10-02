import { createHash } from "node:crypto";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, dirname, sep } from "node:path";
import type { GitPublishState } from "@lcode/shared";
import type { GitCommandProvider } from "../providers/gitCommandProvider.js";
import { ensureGitCommandSucceeded, ensureRepositoryAvailable } from "./gitCliHelpers.js";
import type { GitCliRepo } from "./gitCliTypes.js";

const MAX_BYTES = 2 * 1024 ** 3;
const MAX_LIST_BYTES = 32 * 1024 ** 2;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const CHANGED = "Git HEAD、分支、暂存区或工作树已变化，请重新确认发布。";

export function assertPublishState(expected: GitPublishState, actual: GitPublishState): void {
  if (
    expected.headCommitHash !== actual.headCommitHash ||
    expected.branchName !== actual.branchName ||
    expected.indexFingerprint !== actual.indexFingerprint ||
    expected.worktreeFingerprint !== actual.worktreeFingerprint
  ) {
    throw new Error(CHANGED);
  }
}

export class GitPublishStateReader {
  constructor(
    private readonly repo: GitCliRepo,
    private readonly command: GitCommandProvider,
  ) {}

  async git(cwd: string, args: string[], allowed = [0]): Promise<string> {
    const result = await this.command.run({ cwd, args, maxOutputBytes: MAX_LIST_BYTES });
    ensureGitCommandSucceeded("git publish state", result, allowed);
    return result.stdout;
  }

  async root(workspacePath: string): Promise<string> {
    this.repo.invalidate(workspacePath);
    return ensureRepositoryAvailable(await this.repo.resolveRepository(workspacePath), "publish")
      .repoRoot;
  }

  private async head(cwd: string) {
    const symbolic = await this.command.run({ cwd, args: ["symbolic-ref", "-q", "HEAD"] });
    ensureGitCommandSucceeded("git symbolic HEAD", symbolic, [0, 1]);
    const ref = symbolic.exitCode === 0 ? symbolic.stdout.trim() : null;
    if (ref && !ref.startsWith("refs/heads/")) throw new Error("无法完整读取当前 Git 分支。");
    const head = await this.command.run({ cwd, args: ["rev-parse", "--verify", "HEAD^{commit}"] });
    if (head.exitCode === 0) {
      ensureGitCommandSucceeded("git HEAD", head);
      return { headCommitHash: head.stdout.trim(), branchName: ref?.slice(11) ?? null };
    }
    // 中文依据：只有确实不存在的 symbolic branch 是 unborn，权限/损坏/截断不能伪装成空 HEAD。
    if (head.timedOut || head.outputTruncated || !ref) throw new Error("无法读取 Git HEAD。");
    const exists = await this.command.run({ cwd, args: ["show-ref", "--verify", "--quiet", ref] });
    ensureGitCommandSucceeded("git unborn HEAD", exists, [1]);
    return { headCommitHash: null, branchName: ref.slice(11) };
  }

  private async hashFile(path: string, budget: { bytes: number }): Promise<string> {
    const file = await open(path, "r");
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile()) throw new Error("发布快照只能读取普通文件或符号链接。");
      budget.bytes += Number(before.size);
      if (budget.bytes > MAX_BYTES)
        throw new Error("发布快照超过 2 GiB 内容上限，请缩小仓库后重新确认。");
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(128 * 1024);
      let bytes = 0;
      while (true) {
        const result = await file.read(buffer, 0, buffer.length, null);
        if (!result.bytesRead) break;
        bytes += result.bytesRead;
        if (bytes > Number(before.size)) throw new Error(CHANGED);
        hash.update(buffer.subarray(0, result.bytesRead));
      }
      const after = await file.stat({ bigint: true });
      if (
        bytes !== Number(before.size) ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        before.mode !== after.mode
      )
        throw new Error(CHANGED);
      return hash.digest("hex");
    } finally {
      await file.close();
    }
  }

  private async metadata(cwd: string) {
    const [head, entries, indexPathRaw] = await Promise.all([
      this.head(cwd),
      this.git(cwd, ["ls-files", "--stage", "-v", "-z"]),
      this.git(cwd, ["rev-parse", "--git-path", "index"]),
    ]);
    const paths: string[] = [];
    for (const entry of entries.split("\0").filter(Boolean)) {
      const match = /^\S ([0-7]{6}) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/.exec(entry);
      if (!match || match[3] !== "0")
        throw new Error("暂存区存在冲突或无法完整读取，不能确认发布。");
      if (match[1] === "160000") throw new Error("发布快照暂不支持子模块，请使用普通 Git 操作。");
      paths.push(match[4]!);
    }
    const indexPath = resolve(cwd, indexPathRaw.trim());
    let index = "absent";
    try {
      index = await this.hashFile(indexPath, { bytes: 0 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { ...head, indexFingerprint: digest(JSON.stringify([entries, index])), paths };
  }

  private async worktree(cwd: string, tracked: string[]): Promise<string> {
    const untracked = await this.git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
    const paths = [...new Set([...tracked, ...untracked.split("\0").filter(Boolean)])].sort();
    // 中文依据：发布快照不按文件数量拒绝；逐文件流式读取仍保留字节预算及并发变更校验。
    const budget = { bytes: 0 };
    const records: string[] = [];
    const canonicalRoot = await realpath(cwd);
    const parents = new Map<string, string>();
    for (const path of paths) {
      if (
        isAbsolute(path) ||
        path.includes("\ufffd") ||
        path.split("/").some((part) => part === ".." || part.toLowerCase() === ".git")
      )
        throw new Error("无法完整读取 Git 文件路径。");
      const absolute = resolve(cwd, path);
      try {
        const info = await lstat(absolute, { bigint: true });
        const parent = dirname(absolute);
        let canonicalParent = parents.get(parent);
        if (!canonicalParent) {
          canonicalParent = await realpath(parent);
          parents.set(parent, canonicalParent);
        }
        const inside = relative(canonicalRoot, canonicalParent);
        if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
          throw new Error("发布快照不能读取仓库外的符号链接目录。");
        const content = info.isSymbolicLink()
          ? `link:${(await readlink(absolute, { encoding: "buffer" })).toString("hex")}`
          : info.isFile()
            ? await this.hashFile(absolute, budget)
            : null;
        if (content === null) throw new Error("Git 工作树包含无法完整捕获的目录或特殊文件。");
        const after = await lstat(absolute, { bigint: true });
        if (
          info.ino !== after.ino ||
          info.size !== after.size ||
          info.mode !== after.mode ||
          info.mtimeNs !== after.mtimeNs ||
          info.ctimeNs !== after.ctimeNs
        )
          throw new Error(CHANGED);
        records.push(JSON.stringify([path, Number(info.mode & 0o111n), content]));
      } catch (error) {
        // 中文依据：删除、新增与重命名提交不能改变工作树指纹；摘要只记录实际存在的文件，不记录 index 分类。
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return digest(records.join("\n"));
  }

  private async sample(cwd: string): Promise<GitPublishState> {
    const before = await this.metadata(cwd);
    const worktreeFingerprint = await this.worktree(cwd, before.paths);
    const after = await this.metadata(cwd);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(CHANGED);
    return {
      headCommitHash: before.headCommitHash,
      branchName: before.branchName,
      indexFingerprint: before.indexFingerprint,
      worktreeFingerprint,
    };
  }

  async capture(workspacePath: string): Promise<GitPublishState> {
    const cwd = await this.root(workspacePath);
    // 中文依据：不复用 status/行数缓存；双重读取真实字节，捕获期间发生变化即拒绝，不靠等待掩盖并发。
    const first = await this.sample(cwd);
    const second = await this.sample(cwd);
    assertPublishState(first, second);
    return second;
  }

  async assertCurrent(workspacePath: string, expected: GitPublishState): Promise<void> {
    assertPublishState(expected, await this.capture(workspacePath));
  }
}
