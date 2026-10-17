import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "cancel, close and Escape discard project drafts immediately without confirmation or writes",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    await mkdir(".artifacts/project-form", { recursive: true });
    for (const [width, height, english] of [
      [1280, 850, false],
      [390, 640, false],
      [844, 390, true],
    ]) {
      const context = await browser.newContext({ viewport: { width, height } });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(
        `http://127.0.0.1:${port}/test/fixtures/sidebar-organization.html?theme=sepia-light${english ? "&english" : ""}`,
      );
      await page.evaluate(() =>
        document.documentElement.style.setProperty("--ui-font-size", "20px"),
      );
      const open = async () => {
        await page.getByText("网站项目", { exact: true }).click({ button: "right" });
        await page
          .getByRole("menuitem", { name: english ? "Edit project…" : "编辑项目…", exact: true })
          .click();
        await page
          .getByTestId("sidebar-project-editor")
          .getByLabel(english ? "Project name" : "项目名称", { exact: true })
          .waitFor();
        return page.getByTestId("sidebar-project-editor");
      };
      for (const action of ["cancel", "close", "escape"]) {
        const editor = await open();
        const name = editor.getByLabel(english ? "Project name" : "项目名称", { exact: true });
        assert.equal(await name.inputValue(), "网站项目");
        await name.fill("应被取消的草稿");
        const footer = editor.getByTestId("project-editor-footer");
        assert.equal(await footer.getByRole("button").count(), 2);
        if (action === "cancel") {
          await editor.getByRole("button", { name: /repo · (用途和说明|Purpose)/ }).click();
          await editor
            .getByRole("textbox", { name: english ? "Purpose" : "用途和说明", exact: true })
            .fill("取消输入中的用途");
          await page.screenshot({ path: `.artifacts/project-form/cancel-${width}.png` });
          await footer
            .getByRole("button", { name: english ? "Cancel" : "取消", exact: true })
            .click();
        } else if (action === "close") {
          await editor
            .getByRole("button", { name: english ? "Close" : "关闭", exact: true })
            .click();
        } else await page.keyboard.press("Escape");
        await editor.waitFor({ state: "detached" });
        assert.equal(
          await page
            .getByRole("button", { name: /继续编辑|放弃修改|Keep editing|Discard changes/ })
            .count(),
          0,
        );
      }
      assert.equal(
        await page.evaluate(
          () =>
            globalThis.__sidebarOrganization.calls.filter((call) => call.method === "project")
              .length,
        ),
        0,
      );
      assert.deepEqual(errors, []);
      await context.close();
    }
  },
);

test(
  "existing-project folder tabs switch back only after a successful addition and preserve the draft",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/sidebar-organization.html`);
    await page.getByText("网站项目", { exact: true }).waitFor();
    await page.evaluate(() => {
      globalThis.__sidebarOrganization.settings().localProjects.push({
        id: "library",
        name: "共享目录项目",
        primaryFolderPath: "/fixture/common",
        sourceFolderPaths: ["/fixture/common", "/fixture/tools", "/fixture/missing"],
      });
    });
    await page.getByText("网站项目", { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "编辑项目…", exact: true }).click();
    const editor = page.getByTestId("sidebar-project-editor");
    const source = editor.getByRole("tab", { name: "源文件夹", exact: true });
    const existing = editor.getByRole("tab", { name: "从已有项目选择", exact: true });
    await source.waitFor();
    await editor.getByLabel("项目名称", { exact: true }).fill("切换时保留的项目名");
    const selectPath = (path) =>
      editor.getByRole("tabpanel").getByRole("button", { name: new RegExp(path) });
    await existing.click();
    assert.equal(await source.getAttribute("aria-selected"), "false");
    assert.equal(await editor.getByTestId("project-folder-list").count(), 0);
    await selectPath("/fixture/common").click();
    await editor.locator('[data-project-member="/fixture/common"]').waitFor();
    assert.equal(await source.getAttribute("aria-selected"), "true");
    assert.equal(
      await editor.getByLabel("项目名称", { exact: true }).inputValue(),
      "切换时保留的项目名",
    );
    await editor.getByRole("button", { name: "common · 用途和说明", exact: true }).click();
    await editor.getByRole("textbox", { name: "用途和说明", exact: true }).fill("共享接口定义");
    await existing.click();
    assert.equal(await selectPath("/fixture/common").isDisabled(), true);
    await selectPath("/fixture/tools").click();
    await editor.locator('[data-project-member="/fixture/tools"]').waitFor();
    assert.equal(await source.getAttribute("aria-selected"), "true");
    await editor.getByText("共享接口定义", { exact: true }).waitFor();
    await existing.click();
    await selectPath("/fixture/missing").click();
    await editor.getByRole("alert").filter({ hasText: "Fixture directory not found" }).waitFor();
    assert.equal(await existing.getAttribute("aria-selected"), "true");
    await source.click();
    assert.equal(await editor.locator('[data-project-member="/fixture/missing"]').count(), 0);
    assert.deepEqual(
      await page.evaluate(
        () => globalThis.__sidebarOrganization.settings().localProjects[0].sourceFolderPaths,
      ),
      ["/fixture/repo"],
    );
    await mkdir(".artifacts/project-form", { recursive: true });
    await page.screenshot({ path: ".artifacts/project-form/tabs-desktop.png" });
    await page.setViewportSize({ width: 390, height: 640 });
    await page.evaluate(() => document.documentElement.style.setProperty("--ui-font-size", "20px"));
    await existing.click();
    assert.equal(await editor.evaluate((node) => node.scrollWidth > node.clientWidth), false);
    const tabBox = await existing.boundingBox();
    assert.ok(tabBox.y >= 0 && tabBox.y + tabBox.height <= 640);
    await page.screenshot({ path: ".artifacts/project-form/tabs-mobile.png" });
    await editor.getByRole("button", { name: "取消", exact: true }).click();
    await editor.waitFor({ state: "detached" });
    assert.equal(
      await page.evaluate(
        () =>
          globalThis.__sidebarOrganization.calls.filter((call) => call.method === "project").length,
      ),
      0,
    );
  },
);
