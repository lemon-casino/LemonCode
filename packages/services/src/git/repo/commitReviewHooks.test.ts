import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { createGitCommandProvider } from "../providers/gitCommandProvider.js";
import { createGitCliRepo } from "./gitCliRepo.js";
import { CommitReviewRepo } from "./commitReviewRepo.js";

const run = promisify(execFile);
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "lcode-review-hooks-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args: string[]) =>
    (await run("git", args, { cwd: root, windowsHide: true })).stdout;
  await git("init", "-q");
  for (const [key, value] of [
    ["user.name", "Test"],
    ["user.email", "test@example.invalid"],
    ["core.autocrlf", "false"],
    ["commit.gpgsign", "false"],
    ["core.hooksPath", "custom hooks"],
  ])
    await git("config", key!, value!);
  await writeFile(join(root, ".git", "empty-ignore"), "");
  await git("config", "core.excludesFile", join(root, ".git", "empty-ignore"));
  await writeFile(join(root, "x.txt"), "a\nb\n");
  await writeFile(join(root, "other.txt"), "other\n");
  await git("add", ".");
  await git("commit", "-qm", "initial");
  await writeFile(join(root, "x.txt"), "A\nB\n");
  await writeFile(join(root, "other.txt"), "unrelated\n");
  await git("add", "other.txt");
  const review = new CommitReviewRepo(createGitCliRepo(), createGitCommandProvider());
  const snapshot = await review.capture(root, ["x.txt"], true);
  const files = [{ ...snapshot.files[0]!, content: "A\nb\n" }];
  const hook = async (name: string, body: string) => {
    const path = join(root, "custom hooks", name);
    await mkdir(join(root, "custom hooks"), { recursive: true });
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  };
  const head = await git("rev-parse", "HEAD");
  const index = await readFile(join(root, ".git", "index"));
  const unchanged = async () => {
    assert.equal(await git("rev-parse", "HEAD"), head);
    assert.deepEqual(await readFile(join(root, ".git", "index")), index);
    await assert.rejects(readFile(join(root, ".git", "index.lock")), { code: "ENOENT" });
  };
  return { root, git, review, snapshot, files, hook, unchanged };
}

test("原生 Hook 按序执行，读取冻结 index 而非其它会话，消息 Hook 可补充中文纪要", async (t) => {
  const { root, git, review, snapshot, files, hook } = await fixture(t);
  await hook(
    "pre-commit",
    [
      'test "$GIT_EDITOR" = : || exit 1',
      'test "$(git show :x.txt)" = "$(printf \'A\\nb\\n\')" || exit 1',
      'test "$(git show :other.txt)" = other || exit 1',
      "echo pre-commit >> .git/hook-order",
    ].join("\n"),
  );
  await hook(
    "prepare-commit-msg",
    [
      'test "$2" = message || exit 1',
      "printf '\\n审核纪要\\n' >> \"$1\"",
      "echo prepare-commit-msg >> .git/hook-order",
    ].join("\n"),
  );
  await hook("commit-msg", 'grep -q "审核纪要" "$1" || exit 1\necho commit-msg >> .git/hook-order');
  await hook("reference-transaction", 'echo "$1" >> .git/reference-order');
  await hook(
    "post-commit",
    [
      'test "$(git show HEAD:x.txt)" = "$(printf \'A\\nb\\n\')" || exit 1',
      "echo post-commit >> .git/hook-order",
    ].join("\n"),
  );
  const result = await review.commit(snapshot, files, "feat: 第一部分");
  assert.equal(result.warning, undefined);
  assert.equal(
    await readFile(join(root, ".git", "hook-order"), "utf8"),
    "pre-commit\nprepare-commit-msg\ncommit-msg\npost-commit\n",
  );
  assert.equal(
    await readFile(join(root, ".git", "reference-order"), "utf8"),
    "prepared\ncommitted\n",
  );
  assert.equal(await git("log", "-1", "--format=%B"), "feat: 第一部分\n\n审核纪要\n\n");
  assert.equal(await git("show", "HEAD:other.txt"), "other\n");
  assert.equal(await git("show", ":other.txt"), "unrelated\n");
  assert.equal(await readFile(join(root, "x.txt"), "utf8"), "A\nB\n");
});

for (const name of ["pre-commit", "prepare-commit-msg", "commit-msg"] as const) {
  test(`${name} 拒绝时保留原因，不更新 HEAD/index 或执行 post-commit`, async (t) => {
    const { root, review, snapshot, files, hook, unchanged } = await fixture(t);
    await hook(name, 'echo "拒绝未经校验的提交" >&2\nexit 1');
    await hook("post-commit", "echo wrong >> .git/post-ran");
    await assert.rejects(review.commit(snapshot, files, "feat: A"), /拒绝未经校验的提交/);
    await unchanged();
    await assert.rejects(readFile(join(root, ".git", "post-ran")), { code: "ENOENT" });
  });
}

for (const [name, path] of [
  ["pre-commit", "x.txt"],
  ["pre-commit", "other.txt"],
  ["prepare-commit-msg", "x.txt"],
  ["commit-msg", "other.txt"],
] as const) {
  test(`${name} 暂存 ${path} 的未审核内容时拒绝，不污染真实 index`, async (t) => {
    const { review, snapshot, files, hook, unchanged } = await fixture(t);
    await hook(name, `git add -- ${path}`);
    await assert.rejects(review.commit(snapshot, files, "feat: A"), /Hook 已修改冻结提交补丁/);
    await unchanged();
  });
}

test("Hook 格式化工作树后要求重新审核，不擅自回滚格式化内容", async (t) => {
  const { root, review, snapshot, files, hook, unchanged } = await fixture(t);
  await hook("pre-commit", "printf 'formatted\\nB\\n' > x.txt");
  await assert.rejects(review.commit(snapshot, files, "feat: A"), /重新审核/);
  await unchanged();
  assert.equal(await readFile(join(root, "x.txt"), "utf8"), "formatted\nB\n");
});

test("消息 Hook 清空消息时拒绝提交并释放 index 锁", async (t) => {
  const { review, snapshot, files, hook, unchanged } = await fixture(t);
  await hook("commit-msg", ': > "$1"');
  await assert.rejects(review.commit(snapshot, files, "feat: A"), /消息.*空/);
  await unchanged();
});

test("reference-transaction 原生拒绝时不发布提交或 index", async (t) => {
  const { review, snapshot, files, hook, unchanged } = await fixture(t);
  await hook(
    "reference-transaction",
    '[ "$1" != prepared ] || { echo reference-denied >&2; exit 1; }',
  );
  await assert.rejects(review.commit(snapshot, files, "feat: A"), /reference-denied|transaction/);
  await unchanged();
});

for (const failure of ["timeout", "truncated", "exit"] as const) {
  test(`ref 已更新后通知 ${failure} 不误报失败，发布 index 并运行 post-commit`, async (t) => {
    const { root, git, snapshot, files, hook } = await fixture(t);
    await hook("post-commit", "echo notified >> .git/post-ran");
    const provider = createGitCommandProvider();
    const command = {
      ...provider,
      run: async (options: Parameters<typeof provider.run>[0]) => {
        const result = await provider.run(options);
        return options.args.includes("update-ref")
          ? {
              ...result,
              stderr: "reference notification interrupted",
              exitCode: failure === "exit" ? 1 : result.exitCode,
              timedOut: failure === "timeout",
              outputTruncated: failure === "truncated",
            }
          : result;
      },
    };
    const review = new CommitReviewRepo(createGitCliRepo(), command);
    const committed = await review.commit(snapshot, files, "feat: A");
    assert.equal((await git("rev-parse", "HEAD")).trim(), committed.commitHash);
    assert.match(committed.warning!, /提交已经成功.*引用通知/s);
    assert.equal(await git("show", ":x.txt"), "A\nb\n");
    assert.equal(await git("show", ":other.txt"), "unrelated\n");
    assert.equal(await readFile(join(root, ".git", "post-ran"), "utf8"), "notified\n");
    assert.equal(snapshot.version, "invalid");
  });
}

test("post-commit 失败返回已提交事实与警告，不伪装成提交失败", async (t) => {
  const { git, review, snapshot, files, hook } = await fixture(t);
  await hook("post-commit", "echo notification-denied >&2\nexit 1");
  const result = await review.commit(snapshot, files, "feat: A");
  assert.equal((await git("rev-parse", "HEAD")).trim(), result.commitHash);
  assert.match(result.warning!, /已.*成功.*post-commit.*notification-denied/s);
  assert.equal(snapshot.version, "invalid");
  assert.equal(await git("show", ":other.txt"), "unrelated\n");
});

for (const change of ["worktree", "ref"] as const) {
  test(`post-commit 修改 ${change} 后剩余候选失效，仍返回本次已提交事实`, async (t) => {
    const { root, git, review, snapshot, files, hook } = await fixture(t);
    await hook(
      "post-commit",
      change === "worktree"
        ? "printf 'post-change\\n' > x.txt"
        : [
            'next=$(git commit-tree "HEAD^{tree}" -p HEAD -m hook-followup) || exit 1',
            'git update-ref HEAD "$next" HEAD',
          ].join("\n"),
    );
    const result = await review.commit(snapshot, files, "feat: A");
    assert.ok(result.commitHash);
    assert.match(result.warning!, /提交已成功.*重新审核/);
    assert.equal(snapshot.version, "invalid");
    if (change === "worktree") {
      assert.equal((await git("rev-parse", "HEAD")).trim(), result.commitHash);
      assert.equal(await readFile(join(root, "x.txt"), "utf8"), "post-change\n");
    } else {
      assert.equal((await git("rev-parse", "HEAD^1")).trim(), result.commitHash);
    }
  });
}

test("无实际校验内容的 Husky 占位 Hook 正常通过，不再因存在文件而拦截", async (t) => {
  const { root, git, review, snapshot, files } = await fixture(t);
  await git("config", "core.hooksPath", ".husky/_");
  const path = join(root, ".husky", "_", "pre-commit");
  await mkdir(join(root, ".husky", "_"), { recursive: true });
  await writeFile(
    path,
    '#!/bin/sh\ns="$(dirname "$0")/../pre-commit"\n[ -f "$s" ] || exit 0\nsh "$s" "$@"\n',
  );
  await chmod(path, 0o755);
  const result = await review.commit(snapshot, files, "feat: A");
  assert.equal(result.warning, undefined);
  assert.equal((await git("rev-parse", "HEAD")).trim(), result.commitHash);
});

for (const failure of ["unsupported", "timeout", "truncated"] as const) {
  test(`原生 Hook ${failure} 时明确拒绝，不能静默跳过校验`, async (t) => {
    const { review, snapshot, files, unchanged } = await fixture(t);
    const provider = createGitCommandProvider();
    const command = {
      ...provider,
      run: async (options: Parameters<typeof provider.run>[0]) => {
        if (options.args[0] !== "hook") return provider.run(options);
        const result = await provider.run({ ...options, args: ["--version"] });
        return {
          ...result,
          stdout: "",
          stderr: failure === "unsupported" ? "git: 'hook' is not a git command" : "",
          exitCode: failure === "unsupported" ? 1 : 0,
          timedOut: failure === "timeout",
          outputTruncated: failure === "truncated",
        };
      },
    };
    const guarded = new CommitReviewRepo(createGitCliRepo(), command);
    await assert.rejects(guarded.commit(snapshot, files, "feat: A"), /Hook.*pre-commit/);
    await unchanged();
    await review.assertCurrent(snapshot);
  });
}

for (const content of [Buffer.alloc(1_048_577, "a"), Buffer.from([0xff]), Buffer.from([0])]) {
  test(`消息 Hook 写入超限或非文本消息（${content.length} bytes）时不提交`, async (t) => {
    const { snapshot, files, unchanged } = await fixture(t);
    const provider = createGitCommandProvider();
    const command = {
      ...provider,
      run: async (options: Parameters<typeof provider.run>[0]) => {
        const result = await provider.run(options);
        if (options.args[0] === "hook" && options.args.includes("commit-msg"))
          await writeFile(options.args.at(-1)!, content);
        return result;
      },
    };
    const guarded = new CommitReviewRepo(createGitCliRepo(), command);
    await assert.rejects(guarded.commit(snapshot, files, "feat: A"), /消息.*超限|消息.*UTF-8/);
    await unchanged();
  });
}

test(
  "POSIX 不可执行的 Hook 由 Git 忽略，不误判为活动 Hook",
  {
    skip: process.platform === "win32" ? "Git for Windows 不依赖 POSIX executable 位" : false,
  },
  async (t) => {
    const { review, snapshot, files, hook } = await fixture(t);
    const path = await hook("pre-commit", "exit 1");
    await chmod(path, 0o644);
    assert.ok((await review.commit(snapshot, files, "feat: A")).commitHash);
  },
);
