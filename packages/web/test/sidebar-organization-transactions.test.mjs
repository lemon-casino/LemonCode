import assert from "node:assert/strict";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "mixed selection, split, undo and dissolve share one atomic organization path",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(45000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/sidebar-organization.html`);
    await page.getByText("本地项目会话", { exact: true }).waitFor();
    await page.getByTestId("sidebar-organize").hover();
    await page.getByRole("menuitem", { name: "批量整理", exact: true }).click();
    await page.getByRole("checkbox", { name: "已选择 网站项目", exact: true }).click();
    const localChat = page
      .locator("[data-task-item-key]")
      .filter({ has: page.getByText("本地项目会话", { exact: true }) });
    await localChat.getByRole("checkbox").click();
    await page.getByRole("checkbox", { name: "已选择 登录优化", exact: true }).click();
    // 右键选中集合中的工作树，保留整批对象；菜单与底部批量操作使用相同引用批次。
    await page.getByText("登录优化", { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "新建分区并移入…", exact: true }).click();
    let dialog = page.getByTestId("sidebar-organization-dialog");
    await dialog.getByLabel("分区名称", { exact: true }).fill("组合");
    await dialog.getByRole("button", { name: "确定", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await page.waitForFunction(
      () =>
        globalThis.__sidebarOrganization
          .snapshot()
          .sections.find((section) => section.title === "组合")?.entries.length === 2,
    );
    assert.equal(await page.getByText("本地项目会话", { exact: true }).count(), 1);
    const section = page
      .locator("[data-sidebar-section]")
      .filter({ has: page.getByRole("button", { name: "组合", exact: true }) });
    await section.click({ button: "right" });
    await page.getByRole("menuitem", { name: "拆分分区…", exact: true }).click();
    dialog = page.getByTestId("sidebar-organization-dialog");
    await dialog.getByLabel("分区名称", { exact: true }).fill("拆出的工作树");
    await dialog.getByRole("checkbox", { name: /登录优化/ }).click();
    await dialog.getByRole("button", { name: "确定", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "拆出的工作树", exact: true }).waitFor();
    await page.getByTestId("sidebar-organize").hover();
    await page.getByRole("menuitem", { name: "撤销整理", exact: true }).click();
    await page.waitForFunction(
      () =>
        !globalThis.__sidebarOrganization
          .snapshot()
          .sections.some((section) => section.title === "拆出的工作树"),
    );
    assert.equal(
      await page.evaluate(
        () =>
          globalThis.__sidebarOrganization
            .snapshot()
            .sections.find((section) => section.title === "组合").entries.length,
      ),
      2,
    );
    await section.click({ button: "right" });
    await page.getByRole("menuitem", { name: "解散分区…", exact: true }).click();
    dialog = page.getByTestId("sidebar-organization-dialog");
    await dialog.getByText(/全部内容返回原项目/).waitFor();
    await dialog.getByRole("button", { name: "确定", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await page.getByText("本地项目会话", { exact: true }).waitFor();
    await page.getByText("登录优化", { exact: true }).waitFor();
    assert.equal(
      await page.evaluate(
        () =>
          globalThis.__sidebarOrganization.calls.filter((call) => call.method === "delete").length,
      ),
      0,
    );
    assert.equal(await page.evaluate(() => globalThis.__sidebarOrganization.facts.drafts), 0);
    await page.evaluate(() => globalThis.__sidebarOrganization.externalSection());
    await page.getByRole("button", { name: "其它窗口", exact: true }).waitFor();
    await page.getByTestId("sidebar-organize").hover();
    assert.equal(
      await page.getByRole("menuitem", { name: "撤销整理", exact: true }).isDisabled(),
      true,
    );
    await page.keyboard.press("Escape");
    assert.deepEqual(errors, []);
    await page.close();
  },
);

test(
  "drag targets work while collapsed and binding status changes disable conflicting actions",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(45000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/sidebar-organization.html`);
    await page.getByText("登录优化", { exact: true }).waitFor();
    await page.getByTestId("sidebar-organize").hover();
    await page.getByRole("menuitem", { name: "新建分区", exact: true }).click();
    const dialog = page.getByTestId("sidebar-organization-dialog");
    await dialog.getByLabel("分区名称", { exact: true }).fill("拖放目标");
    await dialog.getByRole("button", { name: "确定", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    const destination = page
      .locator("[data-sidebar-section]")
      .filter({ has: page.getByRole("button", { name: "拖放目标", exact: true }) });
    await destination.getByRole("button", { name: "拖放目标", exact: true }).click();
    await page.locator('[data-binding-id="tree-a"]').dragTo(destination);
    await page.waitForFunction(
      () =>
        globalThis.__sidebarOrganization
          .snapshot()
          .sections.find((section) => section.title === "拖放目标")?.entries[0]?.bindingId ===
        "tree-a",
    );
    assert.equal(
      await destination
        .getByRole("button", { name: "拖放目标", exact: true })
        .getAttribute("aria-expanded"),
      "false",
    );
    await destination.getByRole("button", { name: "拖放目标", exact: true }).click();
    await page.getByText("工作树子会话", { exact: true }).waitFor();
    await page.evaluate(() => globalThis.__sidebarOrganization.setStatus("tree-a", "preparing"));
    await page.getByText("登录优化", { exact: true }).click({ button: "right" });
    assert.equal(
      await page
        .getByRole("menuitem", { name: "新建空白会话", exact: true })
        .getAttribute("aria-disabled"),
      "true",
    );
    await page.getByRole("menuitem", { name: "移出当前分区", exact: true }).click();
    await page.getByText("登录优化", { exact: true }).waitFor();
    assert.equal(
      await page.evaluate(
        () =>
          globalThis.__sidebarOrganization
            .snapshot()
            .sections.find((section) => section.title === "拖放目标").entries.length,
      ),
      0,
    );
    assert.deepEqual(errors, []);
    await page.close();
  },
);
