import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { createGitCliRepo } from "./gitCliRepo.js";
import { CommitReviewRepo } from "./commitReviewRepo.js";
import { createGitCommandProvider } from "../providers/gitCommandProvider.js";

const run = promisify(execFile);
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "lcode-review-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args: string[]) =>
    (await run("git", args, { cwd: root, windowsHide: true })).stdout;
  await git("init", "-q");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.invalid");
  await git("config", "core.autocrlf", "false");
  await writeFile(join(root, ".git", "empty-ignore"), "");
  await git("config", "core.excludesFile", join(root, ".git", "empty-ignore"));
  await git("config", "core.hooksPath", join(root, "no-hooks"));
  await git("config", "commit.gpgsign", "false");
  await writeFile(join(root, "x.txt"), "a\nb\n");
  await writeFile(join(root, "other.txt"), "other\n");
  await git("add", ".");
  await git("commit", "-qm", "initial");
  return {
    root,
    git,
    review: new CommitReviewRepo(createGitCliRepo(), createGitCommandProvider()),
  };
}

test("同文件部分提交不改变工作区，也不带入无关暂存文件", async (t) => {
  const { root, git, review } = await fixture(t);
  await writeFile(join(root, "x.txt"), "A\nB\n");
  await writeFile(join(root, "other.txt"), "unrelated\n");
  await git("add", "other.txt");
  const snapshot = await review.capture(root, ["x.txt"], true);
  const change = { ...snapshot.files[0]!, content: "A\nb\n" };
  const result = await review.commit(snapshot, [change], "feat: first part");
  assert.ok(result.commitHash);
  assert.equal(await git("show", "HEAD:x.txt"), "A\nb\n");
  assert.equal(await git("show", "HEAD:other.txt"), "other\n");
  assert.equal(await readFile(join(root, "x.txt"), "utf8"), "A\nB\n");
  assert.equal(await git("show", ":other.txt"), "unrelated\n");
  assert.equal(await git("show", ":x.txt"), "A\nb\n");
});

test("已暂存同文件全部改动时，部分提交保留剩余暂存补丁", async (t) => {
  const { root, git, review } = await fixture(t);
  await writeFile(join(root, "x.txt"), "A\nB\n");
  await git("add", "x.txt");
  const snapshot = await review.capture(root, ["x.txt"], true);
  await review.commit(snapshot, [{ ...snapshot.files[0]!, content: "A\nb\n" }], "feat: first part");
  assert.equal(await git("show", ":x.txt"), "A\nB\n");
  assert.match(await git("diff", "--cached"), /\+B/);
});

test("连续两个候选组成冻结最终内容；捕获/预览不改变真实 index", async (t) => {
  const { root, git, review } = await fixture(t);
  await writeFile(join(root, "x.txt"), "A\nB\n");
  const before = await readFile(join(root, ".git", "index"));
  const snapshot = await review.capture(root, ["x.txt"], true);
  const patches = await review.describe(snapshot.files);
  assert.match(patches[0]!.patch, /\+A/);
  assert.deepEqual(await readFile(join(root, ".git", "index")), before);
  const first = { ...snapshot.files[0]!, content: "A\nb\n" };
  await review.commit(snapshot, [first], "feat: A");
  await review.commit(snapshot, [{ ...snapshot.files[0]!, headContent: first.content }], "feat: B");
  assert.equal(await git("show", "HEAD:x.txt"), "A\nB\n");
  assert.equal((await git("diff", "--name-only")).trim(), "");
});

test("仓库要求签名时审核路径不能绕过签名", async (t) => {
  const { root, git, review } = await fixture(t);
  await writeFile(join(root, "x.txt"), "next\n");
  const snapshot = await review.capture(root, ["x.txt"], true);
  const head = await git("rev-parse", "HEAD");
  await git("config", "commit.gpgsign", "true");
  await assert.rejects(review.commit(snapshot, snapshot.files, "feat: A"), /签名/);
  assert.equal(await git("rev-parse", "HEAD"), head);
});

test("ref CAS 前并发提交不能覆盖新 HEAD，也不改变真实 index", async (t) => {
  const { root, git } = await fixture(t);
  await writeFile(join(root, "x.txt"), "next\n");
  const provider = createGitCommandProvider();
  const concurrent = {
    ...provider,
    run: async (options: Parameters<typeof provider.run>[0]) => {
      if (options.args.includes("update-ref")) {
        const old = await git("rev-parse", "HEAD");
        const tree = await git("rev-parse", "HEAD^{tree}");
        const other = await git("commit-tree", tree.trim(), "-p", old.trim(), "-m", "other");
        await git("update-ref", "HEAD", other.trim(), old.trim());
      }
      return provider.run(options);
    },
  };
  const review = new CommitReviewRepo(createGitCliRepo(), concurrent);
  const snapshot = await review.capture(root, ["x.txt"], true);
  const before = await readFile(join(root, ".git", "index"));
  await assert.rejects(review.commit(snapshot, snapshot.files, "feat: A"));
  assert.equal((await git("log", "-1", "--format=%s")).trim(), "other");
  assert.deepEqual(await readFile(join(root, ".git", "index")), before);
});

for (const kind of ["content", "head", "index"] as const) {
  test(`审核后 ${kind} 变化，拒绝旧快照且不提交`, async (t) => {
    const { root, git, review } = await fixture(t);
    await writeFile(join(root, "x.txt"), "A\nb\n");
    const snapshot = await review.capture(root, ["x.txt"], true);
    if (kind === "content") await writeFile(join(root, "x.txt"), "Z\nb\n");
    if (kind === "head") await git("commit", "--allow-empty", "-qm", "other commit");
    if (kind === "index") await git("add", "x.txt");
    const head = await git("rev-parse", "HEAD");
    const index = await git("ls-files", "--stage");
    await assert.rejects(
      review.commit(snapshot, snapshot.files, "feat: reviewed"),
      /审核|review|变化/i,
    );
    assert.equal(await git("rev-parse", "HEAD"), head);
    assert.equal(await git("ls-files", "--stage"), index);
  });
}

test("新文件和删除可提交，拒绝二进制与既有 index 锁", async (t) => {
  const { root, git, review } = await fixture(t);
  await writeFile(join(root, "new.txt"), "new");
  await rm(join(root, "x.txt"));
  const snapshot = await review.capture(root, ["new.txt", "x.txt"], true);
  await review.commit(snapshot, snapshot.files, "feat: new and delete");
  assert.equal(await git("show", "HEAD:new.txt"), "new");
  await assert.rejects(git("show", "HEAD:x.txt"));
  await writeFile(join(root, "binary.dat"), Buffer.from([1, 0, 2]));
  await assert.rejects(review.capture(root, ["binary.dat"], true), /文本|binary/i);
  await writeFile(join(root, "new.txt"), "next");
  const next = await review.capture(root, ["new.txt"], true);
  await writeFile(join(root, ".git", "index.lock"), "existing lock");
  await assert.rejects(review.commit(next, next.files, "feat: next"));
  assert.equal(await readFile(join(root, ".git", "index.lock"), "utf8"), "existing lock");
});
