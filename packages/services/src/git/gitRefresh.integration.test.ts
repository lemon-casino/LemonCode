import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { publishFixture } from "./gitPublishTestHelpers.js";

test("只读 Git 刷新和差异读取不会刷新 index 的 stat cache", async (t) => {
  const fixture = await publishFixture(t);
  const file = join(fixture.root, "a.txt");
  const content = await readFile(file);
  const before = await readFile(join(fixture.root, ".git", "index"));
  // 内容不变而文件 stat 已更新时，普通 status/diff 会回写索引并触发自己的刷新监听。
  await writeFile(file, content);
  await fixture.service.refresh({ ...fixture.request, includeBranchComparison: true });
  await fixture.service.getDiff({ ...fixture.request, path: "a.txt", sourceId: "unstaged" });
  assert.deepEqual(await readFile(join(fixture.root, ".git", "index")), before);
});

test("refresh preserves local changes and diffs when the configured upstream ref is missing", async (t) => {
  const fixture = await publishFixture(t);
  await fixture.remote("origin");
  await fixture.git("push", "-qu", "origin", "main");
  const baseHead = (await fixture.git("rev-parse", "HEAD")).trim();
  await fixture.git("update-ref", "-d", "refs/remotes/origin/main");
  await writeFile(join(fixture.root, "a.txt"), "staged version\n");
  await fixture.git("add", "a.txt");
  await writeFile(join(fixture.root, "a.txt"), "working version\n");
  await writeFile(join(fixture.root, "b.txt"), "local edit\n");
  await writeFile(join(fixture.root, "xx.html"), "<p>untracked</p>\n");
  const readState = async () => ({
    head: await fixture.git("rev-parse", "HEAD"),
    index: await fixture.git("diff", "--cached"),
    config: await fixture.git("config", "--local", "--list"),
    status: await fixture.git("status", "--porcelain=v2", "--branch"),
  });
  const before = await readState();
  assert.match(before.status, /# branch.upstream origin\/main/);
  const result = await fixture.service.refresh({
    ...fixture.request,
    includeIdentity: true,
    includeBranchComparison: true,
  });
  assert.equal(result.summary.trackingBranchName, "origin/main");
  assert.equal(result.identity?.userName, "Fixture");
  assert.deepEqual(
    result.stagedChanges.map((file) => file.workspaceRelativePath),
    ["a.txt"],
  );
  assert.deepEqual(result.unstagedChanges.map((file) => file.workspaceRelativePath).sort(), [
    "a.txt",
    "b.txt",
    "xx.html",
  ]);
  assert.equal(result.branchComparison, null);
  assert.match(result.branchComparisonError!, /bad revision 'origin\/main\.\.\.HEAD'/);
  for (const sourceId of ["staged", "unstaged"] as const) {
    const diff = await fixture.service.getDiff({ ...fixture.request, path: "a.txt", sourceId });
    assert.equal(diff.availability, "patch");
    assert.match(diff.patch!, sourceId === "staged" ? /staged version/ : /working version/);
  }
  assert.deepEqual(await readState(), before, "review must not change the repository state");

  await fixture.git("update-ref", "refs/remotes/origin/main", baseHead);
  await fixture.git("commit", "-qm", "local staged change");
  const recovered = await fixture.service.refresh({
    ...fixture.request,
    includeBranchComparison: true,
  });
  assert.equal(recovered.branchComparisonError, undefined);
  assert.equal(recovered.branchComparison?.baseRef, "origin/main");
  assert.deepEqual(
    recovered.branchComparison?.changes.map((file) => file.workspaceRelativePath),
    ["a.txt"],
  );
});

test("refresh without branch comparison never queries the missing upstream", async (t) => {
  const argsSeen: string[][] = [];
  const fixture = await publishFixture(t, (command) => ({
    ...command,
    run: async (options) => {
      argsSeen.push(options.args);
      return command.run(options);
    },
  }));
  await fixture.remote("origin");
  await fixture.git("push", "-qu", "origin", "main");
  await fixture.git("update-ref", "-d", "refs/remotes/origin/main");
  await writeFile(join(fixture.root, "b.txt"), "local edit\n");
  const result = await fixture.service.refresh({
    ...fixture.request,
    includeBranchComparison: false,
  });
  assert.equal(result.unstagedChanges.length, 1);
  assert.equal(result.branchComparison, null);
  assert.equal(result.branchComparisonError, undefined);
  assert.equal(
    argsSeen.some((args) => args.some((arg) => arg.includes("...HEAD"))),
    false,
  );
});

test("refresh with no upstream returns an ordinary empty comparison", async (t) => {
  const fixture = await publishFixture(t);
  await writeFile(join(fixture.root, "b.txt"), "local edit\n");
  const result = await fixture.service.refresh({
    ...fixture.request,
    includeBranchComparison: true,
  });
  assert.equal(result.unstagedChanges.length, 1);
  assert.equal(result.branchComparison?.baseRef, null);
  assert.deepEqual(result.branchComparison?.changes, []);
  assert.equal(result.branchComparisonError, undefined);
});

test("local status errors still reject refresh instead of becoming empty local lists", async (t) => {
  const pending = new Set<Promise<unknown>>();
  const fixture = await publishFixture(t, (command) => ({
    ...command,
    run: async (options) => {
      if (options.args[0] === "status") throw new Error("fixture local status failed");
      const run = command.run(options);
      pending.add(run);
      try {
        return await run;
      } finally {
        pending.delete(run);
      }
    },
  }));
  await assert.rejects(
    fixture.service.refresh({ ...fixture.request, includeBranchComparison: true }),
    /fixture local status failed/,
  );
  // status 失败不代表同批启动的 numstat 子进程已退出；等待本测试持有的进程后才能清理临时仓库。
  while (pending.size) await Promise.allSettled(pending);
});
