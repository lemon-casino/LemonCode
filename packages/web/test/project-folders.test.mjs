import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

async function transfer(page, names) {
  return page.evaluateHandle((names) => {
    const data = new DataTransfer();
    for (const name of names) data.items.add(new File(["fixture"], name));
    return data;
  }, names);
}
test(
  "compact project forms support folder batches, keep name stationary and isolate modal drag events",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    page.setDefaultTimeout(12000);
    page.setDefaultNavigationTimeout(45000);
    await mkdir(".artifacts/project-form", { recursive: true });
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/project-form.html`);
    for (const creating of [true, false]) {
      if (creating) await page.getByRole("button", { name: "新建项目", exact: true }).click();
      else {
        await page.getByText("网站项目", { exact: true }).click({ button: "right" });
        await page.getByRole("menuitem", { name: "编辑项目…", exact: true }).click();
      }
      const dialog = page.getByTestId(
        creating ? "create-project-dialog" : "sidebar-project-editor",
      );
      const name = dialog.getByLabel("项目名称", { exact: true });
      await name.fill("不随目录数量移动的项目");
      assert.equal(await dialog.getByLabel("项目说明", { exact: true }).count(), 0);
      await dialog.evaluate(async (node) => {
        await Promise.allSettled(node.getAnimations().map((animation) => animation.finished));
      });
      const before = await name.boundingBox();
      await page.evaluate(() =>
        globalThis.__sidebarOrganization.selectCreationBatch([
          "/fixture/front",
          "/fixture/api",
          "/fixture/api",
          "/fixture/shared",
        ]),
      );
      await dialog.getByRole("button", { name: "添加目录", exact: true }).click();
      await dialog.locator('[data-project-member="/fixture/shared"]').waitFor();
      assert.equal(await dialog.locator("[data-project-member]").count(), creating ? 3 : 4);
      const after = await name.boundingBox();
      assert.ok(
        Math.abs(after.y - before.y) < 1,
        "project name must not move after adding folders",
      );
      assert.equal(
        await dialog
          .getByTestId("project-folder-list")
          .evaluate((node) => node.scrollHeight > node.clientHeight),
        true,
      );
      assert.ok((await dialog.boundingBox()).height <= 448, "dialog should use the compact shell");
      assert.equal(await page.locator('[data-slot="dialog-overlay"]').count(), 1);
      const count = await dialog.locator("[data-project-member]").count();
      await page.evaluate(() => globalThis.__sidebarOrganization.selectCreationBatch([]));
      await dialog.getByRole("button", { name: "添加目录", exact: true }).click();
      assert.equal(await dialog.locator("[data-project-member]").count(), count);
      if (!creating) {
        await page.evaluate(() =>
          globalThis.__sidebarOrganization.selectCreationBatch([
            "/fixture/valid",
            "/fixture/invalid.txt",
          ]),
        );
        await dialog.getByRole("button", { name: "添加目录", exact: true }).click();
        await dialog.getByRole("alert").filter({ hasText: "/fixture/invalid.txt" }).waitFor();
        assert.equal(
          await dialog.locator("[data-project-member]").count(),
          count,
          "invalid native selection must not partially append a batch",
        );
      }
      const dataTransfer = await transfer(page, ["contracts", "tools"]);
      const overlay = page.locator('[data-slot="dialog-overlay"]');
      await overlay.dispatchEvent("dragover", { dataTransfer });
      await overlay.dispatchEvent("drop", { dataTransfer });
      assert.equal(await dialog.locator("[data-project-member]").count(), creating ? 3 : 4);
      await dialog.dispatchEvent("dragover", { dataTransfer });
      await dialog.dispatchEvent("drop", { dataTransfer });
      await dialog.locator('[data-project-member="/fixture/tools"]').waitFor();
      assert.equal(await dialog.locator("[data-project-member]").count(), creating ? 5 : 6);
      assert.equal(await page.getByTestId("background-drag-state").innerText(), "inactive");
      assert.deepEqual(await page.evaluate(() => globalThis.__sidebarOrganization.dragCalls), {
        react: 0,
        document: 0,
      });
      await page.screenshot({
        path: `.artifacts/project-form/folders-${creating ? "create" : "edit"}.png`,
      });
      const many = await transfer(
        page,
        Array.from({ length: 22 }, (_, index) => `limit-${index}`),
      );
      await dialog.dispatchEvent("drop", { dataTransfer: many });
      await page.waitForFunction(
        () => document.querySelectorAll("[data-project-member]").length === 20,
      );
      assert.equal(
        await dialog.getByRole("button", { name: "添加目录", exact: true }).isDisabled(),
        true,
      );
      await dialog.getByRole("alert").filter({ hasText: "20" }).waitFor();
      await many.dispose();
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      await dataTransfer.dispose();
    }
    const dataTransfer = await transfer(page, ["normal-drag"]);
    await page.locator("main").dispatchEvent("dragover", { dataTransfer });
    await page.getByTestId("background-drag-state").filter({ hasText: "active" }).waitFor();
    assert.ok((await page.evaluate(() => globalThis.__sidebarOrganization.dragCalls.react)) > 0);
  },
);
