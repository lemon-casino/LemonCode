import { access, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { WorktreeBinding } from "../contract.js";
import type { WorktreeGitPort } from "../nodeTypes.js";
import type { WorktreeGit } from "../app/ports.js";

export function createWorktreeGit(port: WorktreeGitPort): WorktreeGit {
  async function command(
    cwd: string,
    args: string[],
    extra?: { stdin?: string; env?: Record<string, string> },
  ) {
    const result = await port.run({ cwd, args, ...extra, maxOutputBytes: 8 * 1024 * 1024 });
    if (result.exitCode !== 0 || result.timedOut || result.outputTruncated)
      throw new Error(result.stderr.trim() || "Git worktree command failed");
    return result.stdout.trim();
  }
  async function inspect(path: string) {
    const root = await realpath(await command(path, ["rev-parse", "--show-toplevel"]));
    const commonDirectory = await realpath(
      await command(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    );
    const head = await command(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
    const branch = (
      await port.run({ cwd: root, args: ["symbolic-ref", "--quiet", "--short", "HEAD"] })
    ).stdout.trim();
    return { root, commonDirectory, head, branch };
  }
  async function assertIdle(path: string) {
    for (const marker of [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-merge",
      "rebase-apply",
      "index.lock",
    ]) {
      const candidate = await command(path, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        marker,
      ]);
      try {
        await access(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      throw new Error(`Git operation is already in progress: ${marker}`);
    }
  }
  async function workingTree(cwd: string, head: string) {
    const temporary = await mkdtemp(join(tmpdir(), "lcode-worktree-capture-"));
    const env = { GIT_INDEX_FILE: join(temporary, "index") };
    try {
      await command(cwd, ["read-tree", head], { env });
      await command(cwd, ["add", "-A", "--", "."], { env });
      return await command(cwd, ["write-tree"], { env });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  return {
    run: (params) => port.run(params),
    command,
    inspect,
    assertIdle,
    async registered(root, path) {
      const list = await command(root, ["worktree", "list", "--porcelain", "-z"]);
      return list
        .split("\0")
        .some((line) => line.startsWith("worktree ") && resolve(line.slice(9)) === resolve(path));
    },
    async snapshot(binding: WorktreeBinding, acknowledgeIgnored, includeIgnored = true) {
      const cwd = binding.checkoutPath;
      await assertIdle(cwd);
      const head = await command(cwd, ["rev-parse", "HEAD"]);
      const ignoredPaths = includeIgnored
        ? (await command(cwd, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]))
            .split("\0")
            .filter(Boolean)
        : [];
      if (ignoredPaths.length && !acknowledgeIgnored)
        throw new Error(
          `Archive omits ignored files; explicit acknowledgement required (${ignoredPaths.length})`,
        );
      if (
        (await command(cwd, ["ls-files", "--stage"]))
          .split("\n")
          .some((line) => line.startsWith("160000 "))
      ) {
        throw new Error("Archiving initialized or embedded submodules is not supported");
      }
      const indexTree = await command(cwd, ["write-tree"]);
      const temporary = await mkdtemp(join(tmpdir(), "lcode-worktree-snapshot-"));
      const env = { GIT_INDEX_FILE: join(temporary, "index") };
      try {
        await command(cwd, ["read-tree", head], { env });
        await command(cwd, ["add", "-A", "--", "."], { env });
        const tree = await command(cwd, ["write-tree"], { env });
        const commit = await command(cwd, ["commit-tree", tree, "-p", head], {
          stdin: "LCode worktree archive snapshot\n",
        });
        await command(cwd, ["update-ref", `refs/lcode/worktree-snapshots/${binding.id}`, commit]);
        // index tree 必须单独保持可达；工作文件快照可能没有暂存版本。
        const indexCommit = await command(cwd, ["commit-tree", indexTree, "-p", head], {
          stdin: "LCode worktree archive index\n",
        });
        await command(cwd, [
          "update-ref",
          `refs/lcode/worktree-indexes/${binding.id}`,
          indexCommit,
        ]);
        return { commit, indexTree, head, ignoredPaths, createdAt: new Date().toISOString() };
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    },
    async restoreFiles(binding) {
      if (!binding.snapshot) throw new Error("Worktree archive snapshot is missing");
      // 先把完整快照 materialize，再恢复真实 index，保留 unstaged/untracked 区别。
      await command(binding.checkoutPath, ["read-tree", "--reset", "-u", binding.snapshot.commit]);
      await command(binding.checkoutPath, ["read-tree", binding.snapshot.indexTree]);
    },
    async matchesSnapshot(binding, checkIgnored) {
      if (!binding.snapshot) return false;
      const cwd = binding.checkoutPath;
      const head = await command(cwd, ["rev-parse", "HEAD"]);
      if (
        head !== binding.snapshot.head ||
        (await command(cwd, ["write-tree"])) !== binding.snapshot.indexTree
      )
        return false;
      const expectedTree = await command(cwd, ["rev-parse", `${binding.snapshot.commit}^{tree}`]);
      if ((await workingTree(cwd, head)) !== expectedTree) return false;
      if (checkIgnored) {
        const ignored = (
          await command(cwd, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])
        )
          .split("\0")
          .filter(Boolean)
          .sort();
        if (JSON.stringify(ignored) !== JSON.stringify([...binding.snapshot.ignoredPaths].sort()))
          return false;
      }
      return true;
    },
  };
}

export async function canonicalCheckoutPath(
  git: WorktreeGitPort,
  workspacePath: string,
): Promise<string> {
  const candidate = await realpath(workspacePath);
  const result = await git.run({ cwd: candidate, args: ["rev-parse", "--show-toplevel"] });
  const root = result.exitCode === 0 ? await realpath(result.stdout.trim()) : candidate;
  if ((await lstat(root)).isSymbolicLink())
    throw new Error("Checkout root cannot be a symbolic link");
  return root;
}
