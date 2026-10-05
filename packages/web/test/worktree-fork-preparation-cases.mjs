import assert from "node:assert/strict";

export async function runForkPreparationCases({ t, page, url, calls }) {
  page.setDefaultTimeout(10_000);
  const run = (name, body) =>
    t.test(name, async () => {
      try {
        await body();
      } catch (error) {
        t.diagnostic(error.stack ?? String(error));
        throw error;
      }
    });
  const configure = (values) =>
    page.evaluate((values) => Object.assign(globalThis.__forkPreparationFixture, values), values);
  const fixture = (method) =>
    page
      .waitForFunction(() => Boolean(globalThis.__forkPreparationFixture))
      .then(() => page.evaluate((method) => globalThis.__forkPreparationFixture[method](), method));
  const openFork = async (kind = "default") => {
    await page.getByTestId(`sidebar-row-${kind}`).click({ button: "right" });
    await page.getByTestId("task-fork-menu").hover();
    await page.getByTestId("task-fork-same").waitFor();
  };
  const navigation = () => page.evaluate(() => globalThis.__forkNavigation);

  await run("准备卡读取真实步骤和日志，取消完成前不能切回本地", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url);
    await fixture("beginPreparation");
    const card = page.getByTestId("worktree-preparation-card");
    assert.equal(
      await page
        .getByTestId("draft-composer-header")
        .getByTestId("worktree-preparation-card")
        .count(),
      0,
    );
    assert.equal(
      await page
        .getByTestId("fixture-conversation-stream")
        .getByTestId("worktree-preparation-card")
        .count(),
      1,
    );
    await card.locator('[data-step="checkout"][data-state="running"]').waitFor();
    assert.equal(await card.locator('[data-step="workspace"]').getAttribute("data-state"), "done");
    await card.getByRole("button", { name: "更多详情" }).click();
    assert.match(
      await page.getByTestId("worktree-preparation-log").innerText(),
      /Checking out files/,
    );
    await card.getByRole("button", { name: "改用本地目录" }).click();
    await card.getByText("已请求取消，等待当前步骤收尾；不会执行本次输入。").waitFor();
    assert.equal((await calls()).filter((call) => call.method === "prepare").length, 1);
    assert.equal((await calls()).filter((call) => call.method === "settings.update").length, 0);
    await fixture("finishCancel");
    await card.waitFor({ state: "hidden" });
    const updated = (await calls()).find((call) => call.method === "settings.update");
    assert.equal(
      updated.params.projectExecutionPreferences["/fixture/repo"].executionMode,
      "local",
    );
    assert.equal((await calls()).filter((call) => call.method === "forkCommand").length, 0);
  });

  await run("准备失败保留命令和首条输入；重试不会另建请求", async () => {
    await page.goto(url);
    await fixture("beginPreparation");
    await page.locator('[data-step="checkout"][data-state="running"]').waitFor();
    await fixture("failPreparation");
    await page
      .getByTestId("worktree-preparation-card")
      .getByText("fixture-environment-failed", { exact: true })
      .waitFor();
    const before = await page.evaluate(() => globalThis.__worktreeFixture.draft().creationEnvelope);
    await page
      .getByTestId("worktree-preparation-card")
      .getByRole("button", { name: "重试准备" })
      .click();
    const after = await page.evaluate(() => globalThis.__worktreeFixture.draft());
    assert.equal(after.creationEnvelope.commandId, before.commandId);
    assert.equal(after.creationEnvelope.payload.firstInput.text, "preserved input");
    assert.equal(after.retryRevision, 1);
  });

  await run("托管环境五阶段卡：工具/依赖步骤展开且来源标注可见，推进到依赖", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(url);
    await fixture("beginManagedPreparation");
    const card = page.getByTestId("worktree-preparation-card");
    // 五步展开：工具步 running，空间/检出 done。
    await card.locator('[data-step="tools"][data-state="running"]').waitFor();
    assert.equal(await card.locator('[data-step="workspace"]').getAttribute("data-state"), "done");
    assert.equal(await card.locator('[data-step="checkout"]').getAttribute("data-state"), "done");
    assert.equal(await card.locator('[data-step="dependencies"]').count(), 1);
    // 来源标注：项目声明。
    await card.getByText("工具版本来自项目声明。").waitFor();
    // 推进到依赖阶段：工具步 done、依赖步 running，标注仍在。
    await fixture("advanceToDependencies");
    await card.locator('[data-step="dependencies"][data-state="running"]').waitFor();
    assert.equal(await card.locator('[data-step="tools"]').getAttribute("data-state"), "done");
    await card.getByText("工具版本来自项目声明。").waitFor();
    // 卡片隐藏走既有取消链路：先点改用本地（登记 intent），Host 结算后草稿重置。
    await card.getByRole("button", { name: "改用本地目录" }).click();
    await fixture("finishCancel");
    await card.waitFor({ state: "hidden" });
  });

  await run("工具来源标注随投影切换：应用默认与部分沿用本机", async () => {
    await page.goto(url);
    await page.evaluate(() => {
      globalThis.__forkPreparationFixture.beginManagedPreparation("app-default");
    });
    const card = page.getByTestId("worktree-preparation-card");
    await card.getByText("项目未声明工具版本，使用应用默认版本。").waitFor();
    // 卡片隐藏走既有取消链路：先点改用本地（登记 intent），Host 结算后草稿重置。
    await card.getByRole("button", { name: "改用本地目录" }).click();
    await fixture("finishCancel");
    await card.waitFor({ state: "hidden" });
    await page.evaluate(() => {
      globalThis.__forkPreparationFixture.beginManagedPreparation("partial-host");
    });
    await card.getByText("部分资源沿用本机环境，未完全隔离。").waitFor();
    await card.getByRole("button", { name: "改用本地目录" }).click();
    await fixture("finishCancel");
    await card.waitFor({ state: "hidden" });
  });

  await run("普通、置顶、时间线和分组菜单都能创建同目录会话分叉", async () => {
    for (const kind of ["default", "pinned", "timeline", "grouped"]) {
      await page.goto(url + "?sidebar");
      await openFork(kind);
      assert.match(await page.getByTestId("task-fork-same").innerText(), /同一本地目录|共享/);
      await page.getByTestId("task-fork-same").click();
      await page.waitForFunction(() => globalThis.__forkNavigation?.taskId === "child-same");
      assert.equal((await navigation()).workspacePath, "/fixture/repo");
      const sent = (await calls()).filter((call) => call.method === "forkCommand");
      assert.equal(sent.length, 1);
      assert.equal(sent[0].params.envelope.baseRevision, 7);
      assert.deepEqual(sent[0].params.envelope.payload, { workspaceMode: "same" });
    }
  });

  await run("工作树分叉使用独立模式，失败不跳转，ACK 丢失只查询原请求", async () => {
    await page.goto(url + "?sidebar");
    await page.evaluate(() => globalThis.__worktreeSidebarRows.setBindingId("parent-binding"));
    await configure({ failFork: true });
    await openFork();
    assert.match(await page.getByTestId("task-fork-same").innerText(), /同一工作树/);
    await page.getByTestId("task-fork-worktree").click();
    await page.getByText(/fixture-parent-busy/).waitFor();
    assert.equal(await navigation(), undefined);
    await configure({ failFork: false, loseForkAck: true });
    await page.getByTestId("task-fork-worktree").click();
    await page.getByText(/fixture-ack-lost/).waitFor();
    await page.getByTestId("task-fork-worktree").click();
    await page.waitForFunction(() => globalThis.__forkNavigation?.taskId === "child-worktree");
    assert.equal((await navigation()).workspacePath, "/fixture/repo");
    const sent = (await calls()).filter((call) => call.method === "forkCommand");
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1].params.envelope.payload, { workspaceMode: "worktree" });
    const queried = (await calls()).find(
      (call) =>
        call.method === "forkQuery" && call.params.commands[0]?.sessionId === "sidebar-worktree",
    );
    assert.equal(queried.params.commands[0].commandId, sent[1].params.envelope.commandId);
  });

  await run("非 Git 项目禁用新工作树，键盘仍可创建同目录分叉", async () => {
    await page.goto(url + "?sidebar");
    await page.waitForFunction(() => Boolean(globalThis.__worktreeFixture));
    await page.evaluate(() => {
      globalThis.__worktreeFixture.supported = false;
    });
    await openFork();
    assert.equal(
      await page.getByTestId("task-fork-worktree").getAttribute("aria-disabled"),
      "true",
    );
    await page.getByTestId("task-fork-same").focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => globalThis.__forkNavigation?.taskId === "child-same");
    assert.equal((await calls()).filter((call) => call.method === "forkCommand").length, 1);
  });

  await run("分叉在途禁用重复操作，切换项目后迟到结果不抢回导航", async () => {
    await page.goto(url + "?sidebar");
    await page.waitForFunction(() => Boolean(globalThis.__forkPreparationFixture));
    await configure({ holdFork: true });
    await openFork();
    await page.getByTestId("task-fork-same").click();
    await page.getByRole("status").filter({ hasText: "正在准备会话分叉" }).waitFor();
    assert.equal(await page.getByTestId("task-fork-same").getAttribute("aria-disabled"), "true");
    await page.getByTestId("task-fork-same").click({ force: true });
    assert.equal((await calls()).filter((call) => call.method === "forkCommand").length, 1);
    await page.evaluate(() => {
      globalThis.__worktreeSidebarRows.changeProject();
      globalThis.__forkPreparationFixture.releaseFork();
    });
    await page
      .getByRole("status")
      .filter({ hasText: "正在准备会话分叉" })
      .waitFor({ state: "hidden" });
    assert.equal(await navigation(), undefined);
  });

  await run("手机更多菜单和英文文案使用相同分叉操作，菜单不撑宽页面", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url + "?sidebar&english");
    await page.getByTestId("fork-mobile-menu").click();
    await page.getByTestId("task-fork-menu").click();
    await page.getByTestId("task-fork-same").waitFor();
    assert.match(await page.getByTestId("task-fork-same").innerText(), /local directory/);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.getByTestId("task-fork-same").click();
    await page.waitForFunction(() => globalThis.__forkNavigation?.taskId === "child-same");
  });
}
