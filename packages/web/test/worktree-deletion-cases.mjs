import assert from "node:assert/strict";

export async function runWorktreeDeletionCases({
  t,
  page,
  load,
  configure,
  calls,
  openProjectWorktrees,
}) {
  await t.test(
    "项目工作树内删除：错误可重试，成功自动返回刷新列表，只需一次确认，窄屏可操作",
    async () => {
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await load();
        await configure({ sessionMissing: true });
        await openProjectWorktrees();
        const management = page.getByTestId("project-worktree-management-dialog");
        await management.getByTestId("project-worktree-delete").click();
        await management.getByTestId("worktree-session-missing").waitFor();
        assert.equal(
          await management.getByTestId("worktree-open-commit-review").isDisabled(),
          true,
        );
        const confirmation = page.getByTestId("worktree-discard-dialog");
        assert.match(await confirmation.innerText(), /删除这个工作树/);
        assert.doesNotMatch(await confirmation.innerText(), /强制删除/);
        assert.match(await confirmation.innerText(), /所有聊天记录也会删除/);
        assert.match(await confirmation.innerText(), /会话诊断文件及托管环境的私有数据和缓存/);
        assert.doesNotMatch(await confirmation.innerText(), /聊天记录保留/);
        assert.match(await confirmation.innerText(), /\/fixture\/worktrees\/task/);
        await confirmation.getByRole("button", { name: "取消", exact: true }).click();
        assert.equal(
          (await calls()).some((call) => call.method === "archive"),
          false,
        );
        await configure({ failArchive: true });
        await management.getByTestId("worktree-discard").click();
        await confirmation.getByTestId("worktree-discard-confirm").click();
        await confirmation.getByRole("alert").getByText("fixture-archive-failed").waitFor();
        await configure({ failArchive: false });
        await confirmation.getByTestId("worktree-discard-confirm").click();
        await confirmation.waitFor({ state: "hidden" });
        await management.getByText("暂无工作树", { exact: true }).waitFor();
        assert.equal(await management.getByTestId("project-worktree-delete").count(), 0);
        assert.equal(
          await management.getByRole("button", { name: "返回项目工作树", exact: true }).count(),
          0,
        );
        const requests = (await calls()).filter((call) => call.method === "archive");
        assert.equal(requests.length, 2, "一次失败和一次重试成功，不需要第二次删除");
        const request = requests.at(-1).params;
        assert.deepEqual(request.discard, {
          branch: "worktree/task",
          checkoutPath: "/fixture/worktrees/task",
        });
      }
      await page.setViewportSize({ width: 1280, height: 900 });
    },
  );
  await t.test("没有忽略文件时快照仍可查看，释放目录后条目仍保留在项目工作树", async () => {
    await load();
    await configure({ ignoredCount: 0 });
    await openProjectWorktrees();
    const management = page.getByTestId("project-worktree-management-dialog");
    await management.getByRole("button", { name: "工作树管理", exact: true }).click();
    await management.getByRole("checkbox").check();
    await management.getByRole("button", { name: "保存快照并释放目录", exact: true }).click();
    const snapshot = management.getByTestId("worktree-snapshot-summary");
    await snapshot.getByText("已保存的工作树快照", { exact: true }).waitFor();
    await snapshot.getByText("snapshot", { exact: true }).waitFor();
    assert.equal(await snapshot.getByTestId("worktree-ignored-omissions").count(), 0);
    await management.getByRole("button", { name: "返回项目工作树", exact: true }).click();
    await management.getByText("目录已释放，快照可恢复", { exact: true }).waitFor();
    assert.equal(await management.getByTestId("project-worktree-delete").count(), 1);
    assert.equal(
      (await calls()).some((call) => call.method === "archiveTask"),
      false,
    );
  });
}
