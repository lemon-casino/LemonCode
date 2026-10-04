import assert from "node:assert/strict";

export async function runBranchPickerCases({ t, page, url, calls, select }) {
  await t.test("两种选择器共享搜索及行布局；键盘基线选择无 Git 写入", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url);
    await page.getByTestId("git-branch-switcher-trigger").click();
    const local = page.locator('[data-testid="git-branch-row"][data-branch-name="feature"]');
    await local.waitFor();
    const style = await local.getAttribute("class");
    const search = page.locator('[data-slot="command-input"]');
    await search.fill("FEATURE");
    assert.equal(
      await page.locator('[data-testid="git-branch-row"][data-branch-name="L-GO"]').count(),
      0,
    );
    await search.press("Escape");
    await select("draft-execution-mode", "独立工作树");
    await page.getByTestId("worktree-base-trigger").click();
    const base = page.locator('[data-testid="git-branch-row"][data-branch-name="feature"]');
    await base.waitFor();
    assert.equal(await base.getAttribute("class"), style);
    await search.fill("FEATURE");
    await search.press("ArrowDown");
    await search.press("Enter");
    assert.match(await page.getByTestId("worktree-base-trigger").innerText(), /feature/);
    await page.getByTestId("worktree-base-trigger").click();
    assert.equal(
      await page
        .locator('[data-testid="git-branch-row"][data-branch-name="feature"]')
        .getAttribute("data-checked"),
      "true",
    );
    assert.equal(
      (await calls()).some((call) => ["prepare", "switchBranch"].includes(call.method)),
      false,
    );
    await search.fill("feature");
    await search.press("Tab");
    assert.equal(
      await page
        .locator('[data-testid="git-branch-delete"][data-branch-name="feature"]')
        .evaluate((element) => element === document.activeElement),
      true,
    );
    await page.keyboard.press("Enter");
    await page.getByTestId("git-branch-delete-dialog").waitFor();
    assert.equal(
      (await calls()).some((call) => call.method === "deleteBranch"),
      false,
    );
  });
  await t.test("占用说明导航到对应管理页；返回、归档和外部工作树均保持保护", async () => {
    for (const worktree of [false, true]) {
      await page.goto(`${url}?occupiedBranch`);
      if (worktree) await select("draft-execution-mode", "独立工作树");
      const trigger = page.getByTestId(
        worktree ? "worktree-base-trigger" : "git-branch-switcher-trigger",
      );
      const action = (name) =>
        page.locator(`[data-testid="git-branch-delete"][data-branch-name="${name}"]`);
      await trigger.click();
      await action("worktree/task").click();
      const occupied = page.getByTestId("git-branch-in-use-dialog");
      await occupied.getByTestId("git-branch-open-worktree").waitFor();
      assert.match(await occupied.innerText(), /\/fixture\/worktrees\/task/);
      assert.equal(
        await occupied.getByRole("button", { name: "删除分支", exact: true }).count(),
        0,
      );
      await occupied.getByTestId("git-branch-open-worktree").click();
      await occupied.waitFor({ state: "hidden" });
      const management = page.getByTestId("project-worktree-management-dialog");
      await management.getByTestId("worktree-management-content").waitFor();
      assert.match(await management.innerText(), /worktree\/task/);
      await management.getByRole("button", { name: "返回项目工作树", exact: true }).click();
      await management.getByTestId("project-worktree-list").waitFor();
      await management.getByRole("button", { name: "工作树管理", exact: true }).click();
      assert.equal(
        (await calls()).some((call) => ["archive", "deleteBranch"].includes(call.method)),
        false,
      );
      await management.getByRole("checkbox").check();
      await management.getByRole("button", { name: "保存快照并释放目录", exact: true }).click();
      await management.getByRole("button", { name: "恢复工作树目录", exact: true }).waitFor();
      await management.getByTestId("project-worktrees-close").click();
      await trigger.click();
      assert.equal(await action("worktree/task").getAttribute("data-branch-action"), "delete");
      await action("external").click();
      await occupied.getByTestId("git-branch-external-worktree").waitFor();
      assert.equal(await occupied.getByTestId("git-branch-open-worktree").count(), 0);
      assert.equal(
        (await calls()).some((call) => call.method === "deleteBranch"),
        false,
      );
    }
  });
  await t.test("占用查找失败可重试；迟到结果不打开其他项目的管理窗口", async () => {
    await page.goto(`${url}?occupiedBranch`);
    await page.evaluate(() => {
      globalThis.__worktreeFixture.failList = true;
    });
    const trigger = page.getByTestId("git-branch-switcher-trigger");
    await trigger.click();
    await page
      .locator('[data-testid="git-branch-delete"][data-branch-name="worktree/task"]')
      .click();
    const occupied = page.getByTestId("git-branch-in-use-dialog");
    await occupied.getByText("fixture-list-failed").waitFor();
    await page.evaluate(() => {
      globalThis.__worktreeFixture.failList = false;
    });
    await occupied.getByRole("button", { name: "刷新状态", exact: true }).click();
    await occupied.getByTestId("git-branch-open-worktree").waitFor();
    await occupied.getByRole("button", { name: "关闭", exact: true }).click();
    await page.evaluate(() => {
      globalThis.__worktreeFixture.holdList = true;
    });
    await trigger.click();
    await page
      .locator('[data-testid="git-branch-delete"][data-branch-name="worktree/task"]')
      .click();
    await page.evaluate(() => globalThis.__worktreeFixture.chooseScope("remote-b"));
    await page.evaluate(() => globalThis.__worktreeFixture.releaseList());
    await occupied.waitFor({ state: "hidden" });
    assert.equal(await occupied.count(), 0);
    assert.equal(await page.getByTestId("project-worktree-management-dialog").count(), 0);
    assert.equal(
      (await calls()).some((call) => call.method === "deleteBranch"),
      false,
    );
  });
}
