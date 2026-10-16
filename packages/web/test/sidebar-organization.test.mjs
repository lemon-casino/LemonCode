import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "unified sidebar organizes real project, worktree and chat rows without navigating",
  { timeout: 180000 },
  async (t) => {
    const { browser, port, diagnostics } = await startWorkflowProgressBrowser(t);
    t.after(() => {
      const output = diagnostics();
      if (output.includes("Internal server error")) t.diagnostic(output);
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(45000);
    page.on("console", (message) => {
      if (message.type() === "error") t.diagnostic(message.text());
    });
    page.on("response", async (response) => {
      if (response.status() >= 500) t.diagnostic((await response.text()).slice(0, 2000));
    });
    page.on("requestfailed", (request) =>
      t.diagnostic(`${request.url()} ${request.failure()?.errorText}`),
    );
    const errors = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
      t.diagnostic(error.message);
    });
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/sidebar-organization.html`);
    await page.getByText("网站项目", { exact: true }).waitFor();
    await page.getByText("远程服务", { exact: true }).waitFor();
    await page.getByText("登录优化", { exact: true }).waitFor();
    await page.getByText("远程修复", { exact: true }).waitFor();
    await page.getByText("本地项目会话", { exact: true }).waitFor();
    assert.equal(await page.locator('[role="tablist"]').count(), 0);
    assert.equal(await page.evaluate(() => globalThis.__sidebarOrganization.facts.drafts), 0);
    const organize = page.getByTestId("sidebar-organize");
    const composer = page.getByRole("textbox", { name: "Composer" });
    await composer.focus();
    await organize.hover();
    await page.getByRole("menuitem", { name: "新建分区", exact: true }).waitFor();
    assert.equal(
      await composer.evaluate((node) => node === document.activeElement),
      true,
      "hover preserves composer focus",
    );
    await page.getByRole("menuitem", { name: "筛选和排序", exact: true }).hover();
    await page.getByRole("menuitem", { name: "最近创建", exact: true }).waitFor();
    await page.getByRole("menuitem", { name: "最近创建", exact: true }).click();
    await organize.hover();
    await page.getByRole("menuitem", { name: "新建分区", exact: true }).click();
    let dialog = page.getByTestId("sidebar-organization-dialog");
    await dialog.getByLabel("分区名称", { exact: true }).fill("产品迭代");
    await dialog.getByRole("button", { name: "确定", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    const project = page
      .locator("[data-sidebar-entry]")
      .filter({ has: page.getByText("网站项目", { exact: true }) })
      .first();
    await project.getByText("网站项目", { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "移入分区…", exact: true }).click();
    dialog = page.getByTestId("sidebar-organization-dialog");
    await dialog.getByRole("radio", { name: /产品迭代/ }).click();
    await dialog.getByRole("button", { name: "确定", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(await page.getByText("网站项目", { exact: true }).count(), 1);
    assert.equal(
      await page.evaluate(() => globalThis.__sidebarOrganization.facts.selected),
      "unchanged",
    );
    await page.getByText("网站项目", { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "移出当前分区", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByText("本地项目会话", { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "单独移入分区…", exact: true }).click();
    await page
      .getByTestId("sidebar-organization-dialog")
      .getByRole("radio", { name: /产品迭代/ })
      .click();
    await page
      .getByTestId("sidebar-organization-dialog")
      .getByRole("button", { name: "确定", exact: true })
      .click();
    await page.getByTestId("sidebar-organization-dialog").waitFor({ state: "detached" });
    assert.equal(await page.getByText("本地项目会话", { exact: true }).count(), 1);
    await page.getByText("登录优化", { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "移入分区…", exact: true }).click();
    await page
      .getByTestId("sidebar-organization-dialog")
      .getByRole("radio", { name: /产品迭代/ })
      .click();
    await page
      .getByTestId("sidebar-organization-dialog")
      .getByRole("button", { name: "确定", exact: true })
      .click();
    await page.getByTestId("sidebar-organization-dialog").waitFor({ state: "detached" });
    assert.equal(
      await page.evaluate(
        () =>
          globalThis.__sidebarOrganization
            .snapshot()
            .sections.find((section) => section.title === "产品迭代").entries.length,
      ),
      3,
    );
    for (const action of ["置顶任务", "取消置顶任务"]) {
      await page.getByText("本地项目会话", { exact: true }).click({ button: "right" });
      await page.getByRole("menuitem", { name: action, exact: true }).click();
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll("[data-task-item-key]")].filter((node) =>
            node.textContent.includes("本地项目会话"),
          ).length === 1,
      );
      assert.equal(
        await page.evaluate(
          () =>
            globalThis.__sidebarOrganization
              .snapshot()
              .sections.find((section) => section.title === "产品迭代").entries.length,
        ),
        3,
      );
    }
    await page.getByText("本地项目会话", { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "归档任务", exact: true }).click();
    await page.getByText("本地项目会话", { exact: true }).waitFor({ state: "hidden" });
    await page.getByTestId("sidebar-archive-toggle").click();
    await page.getByText("本地项目会话", { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "取消归档任务", exact: true }).click();
    await page.getByText("本地项目会话", { exact: true }).waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "返回工作空间", exact: true }).click();
    await page.getByText("本地项目会话", { exact: true }).waitFor();
    assert.equal(await page.getByText("本地项目会话", { exact: true }).count(), 1);
    await page.getByText("远程服务", { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "新建远程会话", exact: true }).waitFor();
    await page.getByRole("menuitem", { name: "复制远端项目路径", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.evaluate(() => globalThis.__sidebarOrganization.offline());
    await page.getByText("远程服务", { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "重新连接", exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole("menuitem", { name: "新建远程会话", exact: true })
        .getAttribute("aria-disabled"),
      "true",
    );
    assert.equal(
      await page
        .getByRole("menuitem", { name: "移入分区…", exact: true })
        .getAttribute("aria-disabled"),
      null,
    );
    await page.keyboard.press("Escape");
    await page.getByTestId("sidebar-archive-toggle").click();
    await page.getByText("已归档会话", { exact: true }).click({ button: "right" });
    const archivedMenu = await page.getByRole("menuitem").allTextContents();
    assert.ok(archivedMenu.some((label) => label.includes("取消归档")));
    assert.ok(!archivedMenu.some((label) => label === "置顶" || label.includes("分叉")));
    await page.keyboard.press("Escape");
    await page.locator("[data-slot=context-menu-content]").waitFor({ state: "detached" });
    assert.equal(await page.getByText("登录优化", { exact: true }).count(), 0);
    await page.getByRole("button", { name: "返回工作空间", exact: true }).click();
    await page.getByText("登录优化", { exact: true }).waitFor();
    await mkdir(".artifacts/sidebar-organization", { recursive: true });
    await composer.focus();
    await page
      .getByTestId("sidebar")
      .screenshot({ path: ".artifacts/sidebar-organization/desktop.png" });
    await page.reload();
    await page.getByText("产品迭代", { exact: true }).waitFor();
    await page.getByText("本地项目会话", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "网站项目", exact: true }).count(), 1);
    assert.deepEqual(errors, []);
    await page.close();
  },
);

test(
  "organization UI remains usable on mobile, keyboard and each shipped palette",
  { timeout: 180000 },
  async (t) => {
    const { browser, port, diagnostics } = await startWorkflowProgressBrowser(t);
    t.after(() => {
      const output = diagnostics();
      if (output.includes("Internal server error")) t.diagnostic(output);
    });
    const themes = [
      "zai-dark",
      "zai-light",
      "sepia-light",
      "midnight-blue",
      "forest-dark",
      "cinnabar",
      "inkpurple",
    ];
    for (const theme of themes) {
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      });
      page.setDefaultTimeout(10000);
      page.setDefaultNavigationTimeout(45000);
      page.on("console", (message) => {
        if (message.type() === "error") t.diagnostic(message.text());
      });
      page.on("response", async (response) => {
        if (response.status() >= 500) t.diagnostic((await response.text()).slice(0, 2000));
      });
      page.on("requestfailed", (request) =>
        t.diagnostic(`${request.url()} ${request.failure()?.errorText}`),
      );
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(
        `http://127.0.0.1:${port}/test/fixtures/sidebar-organization.html?theme=${theme}&english`,
      );
      await page.evaluate(() => {
        globalThis.__sidebarStage = "open";
        globalThis.__windowErrors = [];
        addEventListener("error", (event) => {
          globalThis.__windowErrors.push({
            message: event.message,
            stage: globalThis.__sidebarStage,
          });
        });
      });
      await page.waitForFunction(
        (theme) => document.documentElement.classList.contains(`theme-${theme}`),
        theme,
      );
      const trigger = page.getByTestId("sidebar-organize");
      await trigger.tap();
      await page.getByRole("menuitem", { name: "Filter and sort", exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await trigger.focus();
      await page.keyboard.press("Enter");
      await page.evaluate(() => {
        globalThis.__sidebarStage = "submenu";
      });
      await page.getByRole("menuitem", { name: "Filter and sort", exact: true }).click();
      await page.getByRole("menuitem", { name: "Recently created", exact: true }).waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page.evaluate(() => {
        globalThis.__sidebarStage = "escape";
      });
      await page.keyboard.press("Escape");
      await page.getByRole("menuitem", { name: "Filter and sort", exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await page.evaluate(() => {
        globalThis.__sidebarStage = "context";
      });
      await page.getByText("本地项目会话", { exact: true }).click({ button: "right" });
      assert.equal(
        await page.getByRole("menuitem", { name: "Open in split pane", exact: true }).count(),
        0,
      );
      await page.keyboard.press("Escape");
      await page.evaluate(() =>
        globalThis.__sidebarOrganization.setReadError(true, "Remote fixture index read denied"),
      );
      await page.getByRole("button", { name: "Read failed · 远程服务", exact: true }).tap();
      await page
        .getByRole("dialog")
        .getByText("Remote fixture index read denied", { exact: true })
        .waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page.keyboard.press("Escape");
      await page.getByTestId("sidebar-archive-toggle").tap();
      await page
        .getByTestId("sidebar-archive-panel")
        .getByText("已归档会话", { exact: true })
        .waitFor();
      await page.getByRole("button", { name: "Back to workspace", exact: true }).tap();
      assert.deepEqual(await page.evaluate(() => globalThis.__windowErrors), []);
      assert.deepEqual(errors, []);
      if (theme === "zai-light")
        await page
          .getByTestId("sidebar")
          .screenshot({ path: ".artifacts/sidebar-organization/mobile.png" });
      await page.close();
    }
  },
);
