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
    "项目工作树内删除：已删除会话不打开审核，取消无副作用，错误可重试，窄屏可操作",
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
        await management.getByTestId("worktree-discard-success").waitFor();
        const request = (await calls()).filter((call) => call.method === "archive").at(-1).params;
        assert.deepEqual(request.discard, {
          branch: "worktree/task",
          checkoutPath: "/fixture/worktrees/task",
        });
        await management.getByRole("button", { name: "返回项目工作树", exact: true }).click();
        await management.getByText("暂无工作树", { exact: true }).waitFor();
      }
      await page.setViewportSize({ width: 1280, height: 900 });
    },
  );
}
