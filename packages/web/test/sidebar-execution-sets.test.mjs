import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "collaboration sets expose scoped repository menus, stable retries, archive/restore and remote isolation",
  { timeout: 180000 },
  async (t) => {
    const { browser, port, diagnostics } = await startWorkflowProgressBrowser(t);
    await mkdir(".artifacts/sidebar-collaboration/videos", { recursive: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 1000 },
      recordVideo: {
        dir: ".artifacts/sidebar-collaboration/videos",
        size: { width: 1280, height: 1000 },
      },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    t.after(() => {
      if (errors.length || diagnostics().includes("Internal server error"))
        t.diagnostic(`${errors.join("\n")}\n${diagnostics().slice(-5000)}`);
    });
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/sidebar-organization.html?sets`);
    const local = page.getByTestId("sidebar-execution-set").filter({ hasText: "前后端登录联调" });
    await local.waitFor();
    const remoteRow = page.getByTestId("sidebar-execution-set").filter({ hasText: "远程登录联调" });
    await remoteRow.waitFor();
    if (
      (await remoteRow
        .getByRole("button", { name: "远程登录联调", exact: true })
        .getAttribute("aria-expanded")) === "true"
    )
      await remoteRow.getByRole("button", { name: "远程登录联调", exact: true }).click();
    if (
      (await local
        .getByRole("button", { name: "前后端登录联调", exact: true })
        .getAttribute("aria-expanded")) !== "true"
    )
      await local.getByRole("button", { name: "前后端登录联调", exact: true }).click();
    await page
      .getByTestId("execution-set-repository")
      .first()
      .getByRole("button", { name: "repo", exact: false })
      .waitFor();
    assert.equal(await page.getByTestId("execution-set-repository").count(), 2);
    await page
      .getByTestId("execution-set-progress")
      .filter({ hasText: "合入目标 1/2 · 部分完成" })
      .waitFor();
    assert.equal(
      await page
        .getByTestId("execution-set-integration-status")
        .filter({ hasText: "已合入目标 · main" })
        .count(),
      1,
    );
    assert.equal(
      await page
        .getByTestId("execution-set-integration-status")
        .filter({ hasText: "验证失败 · main" })
        .count(),
      1,
    );
    await page.getByText("协作工作集会话", { exact: true }).waitFor();
    await page.getByText("协作工作集会话", { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "查看本轮协作范围…", exact: true }).click();
    const scope = page.getByTestId("project-scope-dialog");
    await scope
      .getByText(/\/fixture\/sets\//)
      .first()
      .waitFor();
    assert.equal(await scope.locator(".font-mono").count(), 2);
    await scope.getByTestId("execution-set-shared-hint").waitFor();
    assert.match(
      await scope.getByTestId("execution-set-shared-hint").innerText(),
      /共享实际文件.*并行/,
    );
    await scope.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    await page.screenshot({
      path: ".artifacts/sidebar-collaboration/execution-set-shared-files.png",
    });
    await scope.getByRole("button", { name: "确定", exact: true }).click();
    await scope.waitFor({ state: "detached" });
    await local.click({ button: "right" });
    for (const name of [
      "在此新建会话…",
      "查看协作目录",
      "重命名工作集…",
      "编辑所属项目…",
      "移入分区…",
      "归档整个工作集…",
    ])
      assert.equal(await page.getByRole("menuitem", { name, exact: true }).count(), 1, name);
    assert.match(
      await page
        .getByRole("menuitem", { name: "在此新建会话…", exact: true })
        .getAttribute("title"),
      /共享实际文件/,
    );
    await page.getByRole("menuitem", { name: "在此新建会话…", exact: true }).click();
    const creates = await page.evaluate(() => globalThis.__sidebarOrganization.facts.creates);
    assert.equal(creates.at(-1).executionSetId, "a".repeat(32));
    assert.equal(creates.at(-1).worktree, undefined);
    await page.getByTestId("execution-set-repository").first().click({ button: "right" });
    assert.equal(
      await page.getByRole("menuitem", { name: "查看项目文件", exact: true }).count(),
      1,
    );
    assert.equal(await page.getByRole("menuitem", { name: "工作树管理…", exact: true }).count(), 1);
    assert.equal(
      await page.getByRole("menuitem", { name: /此工作树由协作工作集管理/ }).isDisabled(),
      true,
    );
    await page.keyboard.press("Escape");
    await local.click({ button: "right" });
    await page.getByRole("menuitem", { name: "重命名工作集…", exact: true }).click();
    const rename = page.getByRole("dialog");
    await rename.getByRole("textbox").fill("订单联调");
    await rename.getByRole("button", { name: "保存", exact: true }).click();
    await rename.waitFor({ state: "detached" });
    const renamed = page.getByTestId("sidebar-execution-set").filter({ hasText: "订单联调" });
    await renamed.waitFor();
    await page.evaluate(() => globalThis.__sidebarOrganization.failExecutionSet());
    const backend = page.getByTestId("execution-set-repository").filter({ hasText: "backend" });
    await backend.getByTestId("sidebar-source-error").hover();
    await page.getByRole("tooltip").filter({ hasText: "EACCES reading Git directory" }).waitFor();
    assert.equal(await page.getByText("部分来源不可用", { exact: true }).count(), 0);
    await page.mouse.move(900, 900);
    await renamed.click({ button: "right" });
    await page.getByRole("menuitem", { name: "继续准备工作集", exact: true }).click();
    await page.waitForFunction(
      () => globalThis.__sidebarOrganization.executionSets()[0].status === "ready",
    );
    const retry = await page.evaluate(() =>
      globalThis.__sidebarOrganization.calls.find((call) => call.method === "retrySet"),
    );
    assert.equal(retry.params.operationId, `prepare-${"a".repeat(32)}`);
    await renamed.click({ button: "right" });
    await page.getByRole("menuitem", { name: "归档整个工作集…", exact: true }).click();
    const confirmation = page.getByRole("dialog");
    await confirmation.getByRole("button", { name: "归档", exact: true }).click();
    await confirmation.waitFor({ state: "detached" });
    await renamed.waitFor({ state: "detached" });
    await page.getByTestId("sidebar-archive-toggle").click();
    const archived = page.getByTestId("sidebar-execution-set").filter({ hasText: "订单联调" });
    await archived.waitFor();
    await archived.click({ button: "right" });
    await page.getByRole("menuitem", { name: "恢复整个工作集", exact: true }).click();
    await archived.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "返回工作空间", exact: true }).click();
    await renamed.waitFor();
    const remote = page.getByTestId("sidebar-execution-set").filter({ hasText: "远程登录联调" });
    await remote.getByRole("button", { name: "远程登录联调", exact: true }).click();
    await page.waitForFunction(() =>
      globalThis.__sidebarOrganization.calls.some((call) => call.method === "remoteSetBindings"),
    );
    await page.evaluate(() => globalThis.__sidebarOrganization.offline());
    await remote.waitFor();
    await remote.click({ button: "right" });
    assert.equal(
      await page.getByRole("menuitem", { name: "在此新建会话…", exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await page.getByRole("menuitem", { name: "编辑所属项目…", exact: true }).isEnabled(),
      true,
    );
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "hidden" });
    await mkdir(".artifacts/sidebar-collaboration", { recursive: true });
    await page.screenshot({ path: ".artifacts/sidebar-collaboration/execution-set-dark.png" });
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const touch = await mobile.newPage();
    touch.setDefaultTimeout(12000);
    await touch.goto(
      `http://127.0.0.1:${port}/test/fixtures/sidebar-organization.html?sets&english&theme=zai-light`,
    );
    const touchSet = touch
      .getByTestId("sidebar-execution-set")
      .filter({ hasText: "前后端登录联调" });
    await touchSet.getByRole("button", { name: "More actions", exact: true }).tap();
    await touch.getByRole("menuitem", { name: "New chat here…", exact: true }).waitFor();
    assert.equal(
      await touch.getByRole("menuitem", { name: "New chat here…", exact: true }).isEnabled(),
      true,
    );
    const box = await touch.getByRole("menu").boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 391);
    await touch.getByRole("menu").evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    await touch.screenshot({
      path: ".artifacts/sidebar-collaboration/execution-set-mobile-menu.png",
    });
    assert.deepEqual(errors, []);
  },
);
