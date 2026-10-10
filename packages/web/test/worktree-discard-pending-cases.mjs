import assert from "node:assert/strict";

export async function runWorktreeDiscardPendingCase({
  t,
  page,
  load,
  configure,
  calls,
  openProjectWorktrees,
}) {
  await t.test("删除自动重试期间保持一次确认，完成后桌面和手机直接显示已清理列表", async () => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await load();
      await configure({ holdArchive: true, sessionMissing: true });
      await openProjectWorktrees();
      const management = page.getByTestId("project-worktree-management-dialog");
      await management.getByTestId("project-worktree-delete").click();
      const confirmation = page.getByTestId("worktree-discard-dialog");
      const confirm = confirmation.getByTestId("worktree-discard-confirm");
      await confirm.click();
      await page.waitForFunction(() =>
        globalThis.__worktreeFixture.calls.some((call) => call.method === "archive"),
      );
      assert.equal(await confirm.isDisabled(), true);
      assert.equal(
        await confirmation.getByRole("button", { name: "取消", exact: true }).isDisabled(),
        true,
      );
      assert.equal(await confirmation.getByRole("alert").count(), 0);
      assert.equal((await calls()).filter((call) => call.method === "archive").length, 1);
      // 释放 Host 边界的确定性等待，模拟后端在同一调用内完成重试，无需再点删除。
      await page.evaluate(() => globalThis.__worktreeFixture.releaseArchive());
      await confirmation.waitFor({ state: "hidden" });
      await management.getByText("暂无工作树", { exact: true }).waitFor();
      assert.equal((await calls()).filter((call) => call.method === "archive").length, 1);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  });
}
