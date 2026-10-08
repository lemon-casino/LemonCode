import assert from "node:assert/strict";

export async function runWorktreePublicationCase({
  t,
  page,
  load,
  openProjectWorktrees,
  calls,
  configure,
}) {
  await t.test(
    "审核后验证与合并；响应丢失可核实重试；远端发布冻结目标提交且只重试失败远端",
    async () => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await load();
      await openProjectWorktrees();
      await page
        .getByTestId("project-worktree-list")
        .getByRole("button", { name: "工作树管理", exact: true })
        .click();
      await page.getByTestId("worktree-open-commit-review").click();
      const dialog = page.getByTestId("git-commit-dialog");
      await dialog.getByTestId("worktree-integrate").click();
      const validate = dialog.getByTestId("worktree-validate");
      await validate.waitFor();
      assert.match(
        await dialog.getByTestId("worktree-integration-status").innerText(),
        /合并结果已准备，等待审核；目标分支尚未更新/,
      );
      await dialog.getByTestId("worktree-technical-details").locator("summary").click();
      const evidence = await dialog.getByTestId("worktree-integration-evidence").innerText();
      assert.match(evidence, /来源提交/);
      assert.match(evidence, /共同祖先/);
      assert.ok(evidence.includes("t".repeat(40)));
      assert.ok(evidence.includes("b".repeat(40)));
      assert.equal(await validate.isDisabled(), true);
      assert.equal(
        (await calls()).filter((call) => call.method === "publishIntegration").length,
        0,
      );
      await dialog.getByTestId("worktree-approve-candidate").check();
      await validate.click();
      await dialog.getByTestId("worktree-publish").waitFor();
      assert.equal(await dialog.getByTestId("worktree-publish").innerText(), "确认合并到 L-GO");
      await configure({ failPublication: true });
      await dialog.getByTestId("worktree-publish").click();
      await dialog.getByText("fixture-publication-response-lost").waitFor();
      assert.match(await dialog.getByTestId("worktree-publish").innerText(), /核实并重试/);
      await configure({ failPublication: false });
      await dialog.getByTestId("worktree-publish").click();
      const publish = dialog.getByTestId("worktree-remote-publication");
      await publish.waitFor();
      await dialog.getByTestId("worktree-completed-evidence").locator("summary").first().click();
      assert.match(
        await dialog.getByTestId("worktree-integration-status").innerText(),
        /已合并到 L-GO/,
      );
      await page.getByTestId("git-review-dismiss").click();
      await openProjectWorktrees();
      const management = page.getByTestId("project-worktree-management-dialog");
      await management.getByText("已合并到 L-GO", { exact: true }).waitFor();
      assert.equal(
        await management
          .getByRole("button", { name: "保存快照并释放目录", exact: true })
          .isEnabled(),
        true,
      );
      await management.getByTestId("worktree-open-commit-review").click();
      await publish.waitFor();
      await publish.getByTestId("git-publish-toggle").click();
      assert.match(await publish.innerText(), /发布分支：L-GO/);
      assert.match(await publish.innerText(), /原项目目标分支当前的最新提交/);
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="git-publish-branch-enabled"]').disabled,
      );
      assert.equal(await publish.getByTestId("git-publish-commit-preview").count(), 0);
      await publish.getByTestId("git-publish-branch-enabled").check();
      await publish.getByTestId("git-publish-remote-origin").check();
      await publish.getByTestId("git-publish-remote-backup").check();
      await publish.getByTestId("git-publish-preview").click();
      await publish.getByTestId("git-publish-summary").waitFor();
      assert.match(await publish.getByTestId("git-publish-summary").innerText(), /L-GO/);
      assert.equal((await calls()).filter((call) => call.method === "push").length, 0);
      await publish.getByTestId("git-publish-confirm").click();
      await publish.getByText("fixture-remote-offline").waitFor();
      await page.getByTestId("git-review-dismiss").click();
      await dialog.waitFor({ state: "hidden" });
      await page.getByTestId("git-action-trigger").click();
      await publish.getByText("fixture-remote-offline").waitFor();
      await publish.getByTestId("git-publish-results-back").click();
      assert.equal(await publish.getByTestId("git-publish-confirm").count(), 0);
      await publish.getByTestId("git-publish-back").click();
      await configure({ failRemote: false });
      await publish.getByTestId("git-publish-retry-branch-backup").click();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="git-publish-result-branch-backup"]').dataset
            .status === "success",
      );
      const pushed = (await calls()).filter((call) => call.method === "push");
      assert.deepEqual(
        pushed.map((call) => call.params.remote),
        ["origin", "backup", "backup"],
      );
      for (const call of pushed) {
        assert.equal(call.params.workspacePath, "/fixture/repo");
        assert.equal(call.params.expectedState.headCommitHash, "c".repeat(40));
      }
      await configure({ targetHead: "d".repeat(40) });
      await publish.getByTestId("git-publish-new-plan").click();
      await publish.getByTestId("git-publish-preview").click();
      await publish.getByTestId("git-publish-summary").waitFor();
      assert.ok(
        (await publish.getByTestId("git-publish-summary").innerText()).includes("d".repeat(40)),
      );
      await configure({ targetHead: "e".repeat(40) });
      await publish.getByTestId("git-publish-confirm").click();
      await publish.getByTestId("git-publish-results").waitFor();
      assert.match(await publish.getByTestId("git-publish-results").innerText(), /仓库状态已变化/);
      assert.equal((await calls()).filter((call) => call.method === "push").length, 3);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
    },
  );
}
