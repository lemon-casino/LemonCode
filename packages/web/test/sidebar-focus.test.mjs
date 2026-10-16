import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

async function focus(page, label, touch = false) {
  for (const menu of await page.locator('[data-slot="context-menu-content"]').all())
    await menu.waitFor({ state: "hidden" });
  const trigger = page.getByTestId("sidebar-organize");
  if (touch) await trigger.tap();
  else await trigger.hover();
  const entry = page.getByRole("menuitem", { name: "专注", exact: true });
  if (touch) await entry.tap();
  else await entry.hover();
  const option = page.getByRole("menuitemradio", { name: label, exact: true });
  await option.waitFor();
  if (touch) await option.tap();
  else await option.click();
  await page.getByRole("menu", { name: "专注", exact: true }).waitFor({ state: "hidden" });
  await page.waitForFunction(
    (expected) =>
      JSON.parse(localStorage.getItem("lcode-sidebar-task-preferences") || "{}").focus === expected,
    { 全部: "all", 项目: "projects", 工作树: "worktrees", 会话: "chats" }[label],
  );
}

test(
  "sidebar focus filters content without changing organization or source routing",
  { timeout: 180000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(45000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/sidebar-organization.html`);
    await page.getByText("远程修复", { exact: true }).waitFor();
    assert.equal(await page.getByTestId("sidebar-organize").innerText(), "侧边栏");
    const before = await page.evaluate(() => ({
      snapshot: globalThis.__sidebarOrganization.snapshot(),
      facts: globalThis.__sidebarOrganization.facts,
    }));
    await focus(page, "项目");
    await page.getByText("远程服务", { exact: true }).waitFor();
    assert.equal(await page.getByText("登录优化", { exact: true }).count(), 0);
    assert.equal(await page.locator("[data-task-item-key]:visible").count(), 0);
    await focus(page, "工作树");
    await page.getByText("登录优化", { exact: true }).waitFor();
    await page.getByText("远程修复", { exact: true }).waitFor();
    assert.equal(await page.getByText("网站项目", { exact: true }).count(), 0);
    assert.equal(await page.locator("[data-task-item-key]:visible").count(), 0);
    await focus(page, "会话");
    for (const title of [
      "本地项目会话",
      "工作树主会话",
      "工作树子会话",
      "远程项目会话",
      "远程工作树会话",
      "独立讨论",
      "置顶会话",
    ]) {
      await page.getByText(title, { exact: true }).waitFor();
      assert.equal(await page.getByText(title, { exact: true }).count(), 1);
    }
    assert.equal(await page.locator("[data-sidebar-entry]:visible").count(), 0);
    const remoteChat = page
      .locator("[data-task-item-key]")
      .filter({ has: page.getByText("远程项目会话", { exact: true }) });
    await remoteChat.getByText(/远程服务 · 远程项目/).waitFor();
    await page.getByText("远程项目会话", { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "单独移入分区…", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByText("远程项目会话", { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "标记为未读", exact: true }).click();
    const routed = await page.evaluate(() =>
      globalThis.__sidebarOrganization.calls.find((call) => call.method === "unread-task"),
    );
    assert.equal(
      routed.params.workspaceIdentity,
      await page.evaluate(() => globalThis.__sidebarOrganization.identity),
    );
    await page.getByTestId("sidebar-archive-toggle").click();
    await page.getByText("已归档会话", { exact: true }).waitFor();
    await page.getByRole("button", { name: "返回工作空间", exact: true }).click();
    await page.getByText("工作树子会话", { exact: true }).waitFor();
    assert.equal(await page.getByText("网站项目", { exact: true }).count(), 0);
    const after = await page.evaluate(() => ({
      snapshot: globalThis.__sidebarOrganization.snapshot(),
      facts: globalThis.__sidebarOrganization.facts,
    }));
    assert.deepEqual(after.snapshot, before.snapshot);
    assert.equal(after.facts.connects, before.facts.connects);
    assert.equal(after.facts.drafts, before.facts.drafts);
    assert.equal(after.facts.selected, before.facts.selected);
    await page.reload();
    await page.getByText("工作树子会话", { exact: true }).waitFor();
    assert.equal(await page.getByText("网站项目", { exact: true }).count(), 0);
    await mkdir(".artifacts/sidebar-organization", { recursive: true });
    await page.screenshot({
      path: ".artifacts/sidebar-organization/focus-chats.png",
      animations: "disabled",
    });
    await focus(page, "全部");
    await page.getByText("网站项目", { exact: true }).waitFor();
    await page.getByText("登录优化", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    await page.close();
  },
);

test(
  "empty categories disappear and touch focus can return to all",
  { timeout: 180000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(45000);
    await page.goto(
      `http://127.0.0.1:${port}/test/fixtures/sidebar-organization.html?empty=1&theme=sepia-light`,
    );
    await page.getByText("网站项目", { exact: true }).waitFor();
    await page.waitForFunction(() => Boolean(globalThis.__sidebarOrganization));
    assert.equal(await page.getByTestId("sidebar-worktrees-section").count(), 0);
    assert.equal(await page.getByRole("button", { name: "置顶", exact: true }).count(), 0);
    await focus(page, "工作树", true);
    await page.getByText("暂无内容", { exact: true }).waitFor();
    await page.getByRole("button", { name: "显示全部", exact: true }).tap();
    await page.getByText("网站项目", { exact: true }).waitFor();
    await focus(page, "项目", true);
    await page.reload();
    await page.getByText("网站项目", { exact: true }).waitFor();
    assert.equal(await page.locator("[data-task-item-key]:visible").count(), 0);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.close();
  },
);

test(
  "mixed sections retain placement and full context menus in focused projections",
  { timeout: 180000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(45000);
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/sidebar-organization.html`);
    await page.getByText("远程修复", { exact: true }).waitFor();
    await page.evaluate(() => {
      const api = globalThis.__sidebarOrganization;
      const snapshot = api.snapshot();
      snapshot.sections = [
        {
          id: "mixed",
          title: "混合分区",
          entries: [
            { kind: "project", workspacePath: api.origin, localProjectId: "project" },
            { kind: "worktree", origin: { workspacePath: api.origin }, bindingId: "tree-a" },
          ],
        },
        {
          id: "separate",
          title: "单独放置",
          entries: [
            { kind: "task", workspace: { workspacePath: api.origin }, taskId: "local" },
            {
              kind: "worktree",
              origin: { workspacePath: api.origin, workspaceIdentity: api.identity },
              bindingId: "remote-tree",
            },
          ],
        },
        { id: "empty", title: "空分区", entries: [] },
      ];
      localStorage.setItem("sidebar-fixture-organization", JSON.stringify(snapshot));
    });
    await page.reload();
    await page.getByText("空分区", { exact: true }).waitFor();
    await focus(page, "项目");
    await page.getByText("网站项目", { exact: true }).waitFor();
    assert.equal(await page.getByText("单独放置", { exact: true }).count(), 0);
    assert.equal(await page.getByText("空分区", { exact: true }).count(), 0);
    await page.getByText("混合分区", { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "拆分分区…", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await focus(page, "会话");
    for (const title of [
      "本地项目会话",
      "第二个项目会话",
      "工作树主会话",
      "工作树子会话",
      "远程工作树会话",
    ])
      assert.equal(await page.getByText(title, { exact: true }).count(), 1);
    await page.getByText("本地项目会话", { exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "移出当前分区", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    const before = await page.evaluate(() =>
      localStorage.getItem("lcode-sidebar-tree-expansion-v1"),
    );
    await focus(page, "工作树");
    await page.getByText("登录优化", { exact: true }).waitFor();
    await page.getByText("远程修复", { exact: true }).waitFor();
    assert.equal(await page.locator("[data-task-item-key]:visible").count(), 0);
    await focus(page, "全部");
    await page.getByText("空分区", { exact: true }).waitFor();
    await page.getByText("工作树子会话", { exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => localStorage.getItem("lcode-sidebar-tree-expansion-v1")),
      before,
    );
    await page.close();
  },
);
