import assert from "node:assert/strict";

export async function runGitReviewNavigationCases(t, { page, url }) {
  const dialog = page.getByTestId("git-commit-dialog");
  const fixture = (method, ...args) =>
    page.evaluate(({ method, args }) => globalThis.__gitCommitFixture[method](...args), {
      method,
      args,
    });
  await t.test("遮罩不关闭，X 与手动重开保留冻结审核及编辑内容", async () => {
    for (const english of [false, true]) {
      await page.setViewportSize({ width: english ? 390 : 1280, height: 900 });
      await page.goto(url + (english ? "?english" : ""));
      await fixture("automatic");
      await page.getByTestId("git-review-acknowledge").waitFor();
      await page.getByTestId("git-commit-message-input").fill("fix: keep reviewed draft");
      await page.getByTestId("git-review-acknowledge").click();
      await page.mouse.click(5, 5);
      assert.equal(await dialog.isVisible(), true);
      await page.getByTestId("git-review-dismiss").click();
      await dialog.waitFor({ state: "hidden" });
      await page.getByTestId("git-action-trigger").click();
      assert.equal(
        await page.getByTestId("git-commit-message-input").inputValue(),
        "fix: keep reviewed draft",
      );
      assert.equal(
        await page.getByTestId("git-review-acknowledge").getAttribute("data-state"),
        "checked",
      );
      assert.equal(await dialog.locator("pre").count(), 0);
    }
  });
  await t.test("冻结差异使用已有查看器，返回保留阶段且切换会话使旧返回失效", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url);
    await fixture("automatic");
    await page.getByTestId("git-review-acknowledge").waitFor();
    await page.getByTestId("git-commit-message-input").fill("fix: reviewed once");
    const calls = await page.evaluate(() => globalThis.__gitCommitFixture.calls.length);
    await page.getByTestId("git-review-open-files").click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByTestId("code-viewer-return-review").waitFor();
    assert.equal(
      await page.evaluate(() => globalThis.__gitCommitFixture.previewSource.type),
      "patch",
    );
    assert.equal(
      await page.evaluate(() => globalThis.__gitCommitFixture.previewSource.reviewFiles[0].patch),
      "+fixture",
    );
    await page.getByTestId("code-viewer-return-review").click();
    assert.equal(
      await page.getByTestId("git-commit-message-input").inputValue(),
      "fix: reviewed once",
    );
    assert.equal(await page.evaluate(() => globalThis.__gitCommitFixture.calls.length), calls);
    await page.getByTestId("git-review-open-files").click();
    await fixture("switchSession", "b");
    await page.getByTestId("code-viewer-return-review").waitFor({ state: "hidden" });
    assert.equal(await dialog.isVisible(), false);
  });
  await t.test("一万文件只在独立区域分页渲染；搜索及批量排除作用于当前页", async () => {
    await page.goto(url);
    await fixture(
      "dirty",
      Array.from({ length: 10_000 }, (_, index) => `src/file-${String(index).padStart(5, "0")}.ts`),
    );
    await page.getByTestId("git-action-trigger").click();
    await page.getByTestId("git-scope-open-files").waitFor();
    assert.equal(await dialog.locator("li").count(), 0);
    await page.getByTestId("git-scope-open-files").click();
    const list = page.getByTestId("review-workspace-files");
    await list.waitFor();
    assert.equal(await list.locator("li").count(), 50);
    assert.match(await page.getByTestId("review-file-pagination").innerText(), /10,000|10000/);
    await page.getByTestId("review-exclude-page").click();
    assert.equal(await list.getByText("已排除的审核文件", { exact: true }).count(), 50);
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    assert.equal(await list.locator("li").count(), 50);
    assert.equal(await list.getByText("已排除的审核文件", { exact: true }).count(), 0);
    await page.getByRole("textbox", { name: "搜索文件路径" }).fill("file-09999");
    assert.equal(await list.locator("li").count(), 1);
    await page.getByTestId("review-exclude-matching").click();
    await page.getByRole("textbox", { name: "搜索文件路径" }).fill("src/");
    await page.getByTestId("review-exclude-matching").click();
    await page.getByTestId("code-viewer-return-review").click();
    assert.match(await page.getByTestId("git-commit-scope-counts").innerText(), /已选 0/);
    assert.equal(await page.getByTestId("git-commit-generate-button").isDisabled(), true);
    await page.getByTestId("git-scope-open-files").click();
    await page.getByTestId("review-restore-all").click();
    await page.getByTestId("code-viewer-return-review").click();
    assert.match(await page.getByTestId("git-commit-scope-counts").innerText(), /已排除 0/);
    assert.equal(await page.evaluate(() => globalThis.__gitCommitFixture.calls.length), 0);
  });
  await t.test("提交与合并使用单个窗口；上一步不重放来源提交，关闭重开保留候选确认", async () => {
    await page.goto(url);
    await fixture("executionMode", "worktree");
    await fixture("automatic");
    await page.getByTestId("git-commit-and-merge").waitFor();
    await page.getByTestId("commit-and-merge-control").getByRole("checkbox").check();
    await page.getByTestId("git-commit-and-merge").click();
    await page.getByTestId("worktree-approve-candidate").waitFor();
    assert.equal(await page.getByRole("dialog").count(), 1);
    await page.getByTestId("worktree-approve-candidate").check();
    await page.getByTestId("git-review-stage-back").click();
    assert.equal(
      await page.getByTestId("git-commit-action-item-commit").getAttribute("aria-disabled"),
      "true",
    );
    await page.getByTestId("git-review-stage-back").click();
    await page.getByTestId("git-review-dismiss").click();
    await page.getByTestId("git-action-trigger").click();
    assert.equal(
      await page.getByTestId("worktree-approve-candidate").getAttribute("data-state"),
      "checked",
    );
    assert.equal(await page.evaluate(() => globalThis.__gitCommitFixture.mergeCalls.length), 1);
  });
}
