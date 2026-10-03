import assert from "node:assert/strict";

export async function runWorktreeWorkflowCases({ t, page, url, calls, configure, select }) {
  await t.test("阶段回退只读，关闭重开及外部差异往返保留候选确认", async () => {
    await page.goto(url + "?scenario=review");
    const dialog = page.getByTestId("worktree-task-dialog");
    await page.getByTestId("worktree-integrate").click();
    await page.getByTestId("worktree-approve-candidate").waitFor();
    await page.getByTestId("worktree-stage-back").click();
    assert.equal(await page.getByTestId("worktree-integrate").isDisabled(), true);
    await page.getByTestId("worktree-current-stage").click();
    await page.getByTestId("worktree-approve-candidate").check();
    await page.mouse.click(5, 5);
    assert.equal(await dialog.isVisible(), true);
    await page.getByTestId("git-review-dismiss").click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByTestId("worktree-task-location").getByRole("button").click();
    assert.equal(
      await page.getByTestId("worktree-approve-candidate").getAttribute("data-state"),
      "checked",
    );
    const before = (await calls()).filter((call) =>
      ["integrate", "continue", "publish"].includes(call.method),
    );
    await page.getByTestId("worktree-open-diff").click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByTestId("review-file-workspace").waitFor();
    await page.getByTestId("code-viewer-return-review").click();
    assert.equal(
      await page.getByTestId("worktree-approve-candidate").getAttribute("data-state"),
      "checked",
    );
    assert.deepEqual(
      (await calls()).filter((call) => ["integrate", "continue", "publish"].includes(call.method)),
      before,
    );
  });
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
    await dialog.getByTestId("worktree-stage-back").click();
    assert.equal(await dialog.getByTestId("worktree-integrate").isDisabled(), true);
    assert.equal(await dialog.getByTestId("worktree-target-branch").isDisabled(), true);
    await dialog.getByTestId("worktree-current-stage").click();
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
  await t.test("万级冲突与遗漏清单在独立区域分页，遗漏路径不读取文件内容", async () => {
    await page.goto(url + "?scenario=conflict");
    await configure({ conflicted: true, conflictCount: 10_000 });
    const dialog = page.getByTestId("worktree-task-dialog");
    await dialog.getByTestId("worktree-integrate").click();
    assert.equal(await dialog.locator("li").count(), 20);
    await dialog.getByTestId("worktree-open-diff").click();
    await page.getByRole("textbox", { name: "搜索文件路径" }).fill("file-");
    assert.equal(await page.getByTestId("review-workspace-files").locator("li").count(), 50);
    await page.getByTestId("code-viewer-return-review").click();
    await page.goto(url + "?scenario=review");
    await configure({ ignoredCount: 10_000 });
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "保存快照并归档", exact: true }).click();
    await dialog.getByTestId("worktree-ignored-omissions").locator("summary").click();
    assert.equal(await dialog.locator("li").count(), 0);
    await dialog.getByTestId("worktree-open-omissions").click();
    assert.equal(await page.getByTestId("review-workspace-files").locator("li").count(), 50);
    assert.equal((await calls()).filter((call) => call.method === "diff").length, 0);
    await page.getByTestId("code-viewer-return-review").click();
  });
}
