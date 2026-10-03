import assert from "node:assert/strict";

export async function runWorktreeWorkflowCases({ t, page, url, calls, configure, select }) {
  await t.test("提交并合并需单独审核；失败重试复用请求，提交路径指向工作树", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url + "?scenario=commit");
    const control = page.getByTestId("commit-and-merge-control");
    await control.waitFor();
    const submit = control.getByTestId("git-commit-and-merge");
    assert.equal(await submit.isDisabled(), true);
    await control.getByRole("checkbox").check();
    await select("worktree-target-branch", "feature");
    assert.equal(await submit.isDisabled(), true);
    await select("worktree-target-branch", "L-GO");
    await control.getByRole("checkbox").check();
    await page.getByTestId("scenario-message").fill("changed message");
    assert.equal(await submit.isDisabled(), true);
    await control.getByRole("checkbox").check();
    await configure({ failIntegration: true });
    await submit.click();
    await control.getByText("fixture-integration-unavailable").waitFor();
    await configure({ failIntegration: false });
    await submit.click();
    await page.getByTestId("worktree-validate").waitFor();
    const integrated = (await calls()).filter((call) => call.method === "integrate");
    assert.equal(integrated.length, 2);
    assert.equal(integrated[0].params.requestId, integrated[1].params.requestId);
    const commands = integrated[1].params.sourceCommits;
    assert.deepEqual(
      commands.map((command) => command.message),
      ["changed message", "message B"],
    );
    assert.equal(
      commands.every(
        (command) =>
          command.workspacePath === "/fixture/worktrees/task" && command.review.acknowledged,
      ),
      true,
    );
    assert.equal(await page.getByTestId("scenario-committed").innerText(), "true");
    assert.equal(
      (await calls()).some((call) => call.method === "publishIntegration"),
      false,
    );
  });
  await t.test("冲突入口显示文件；人工继续和 AI 修复后都必须重新审核候选", async () => {
    for (const ai of [false, true]) {
      await page.goto(url + "?scenario=conflict");
      const dialog = page.getByTestId("worktree-task-dialog");
      await configure({ conflicted: true });
      await dialog.getByTestId("worktree-integrate").click();
      await dialog.getByText("file.txt", { exact: true }).waitFor();
      assert.equal(await dialog.getByTestId("worktree-publish").count(), 0);
      await dialog
        .getByRole("button", { name: ai ? "让 AI 解决冲突" : "已处理冲突，继续审核", exact: true })
        .click();
      await dialog.getByTestId("worktree-validate").waitFor();
      assert.equal(await dialog.getByTestId("worktree-validate").isDisabled(), true);
      assert.equal(
        (await calls()).some((call) => call.method === "publishIntegration"),
        false,
      );
      assert.equal(
        (await calls()).some((call) => call.method === "resolveWithAI"),
        ai,
      );
    }
  });
  await t.test("取消保留候选和来源；旧审批不能继续发布，可创建新集成", async () => {
    await page.goto(url + "?scenario=conflict");
    const dialog = page.getByTestId("worktree-task-dialog");
    await dialog.getByTestId("worktree-integrate").click();
    await dialog.getByTestId("worktree-validate").waitFor();
    assert.equal(await dialog.getByTestId("worktree-integrate").isDisabled(), true);
    assert.equal(await dialog.getByTestId("worktree-target-branch").isDisabled(), true);
    await dialog.getByTestId("worktree-cancel-integration").click();
    await dialog.getByText("已取消，提交和集成目录已保留").waitFor();
    assert.equal(await dialog.getByTestId("worktree-validate").count(), 0);
    assert.equal(await dialog.getByTestId("worktree-integrate").isDisabled(), false);
    assert.equal(
      (await calls()).some((call) => call.method === "publishIntegration"),
      false,
    );
    await dialog.getByTestId("worktree-integrate").click();
    await dialog.getByTestId("worktree-validate").waitFor();
  });
}
