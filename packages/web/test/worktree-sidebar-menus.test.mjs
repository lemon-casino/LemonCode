import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

const same = "在同一工作树中创建会话分叉";
const isolated = "在新工作树中创建会话分叉";
const item = (page, name, disabled = false) =>
  page.getByRole("menuitem", { name, exact: true, disabled });

test(
  "Worktree menus check capabilities, preserve the source and match the mobile actions",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      page.setDefaultTimeout(10000);
      // 并行启动的 Vite 首次转换整套共享 UI 可能超过 10 秒；只放宽页面加载，交互断言仍保持 10 秒。
      page.setDefaultNavigationTimeout(45000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "clipboard", {
          value: {
            writeText: async (text) => {
              globalThis.__copied = text;
            },
          },
        });
      });
      await page.goto(`http://127.0.0.1:${port}/test/fixtures/worktree-sidebar.html`);
      await page.getByTestId("sidebar-worktrees-tab").click();
      const tree = page.locator('[data-binding-id="tree-a"]');
      await page.getByText("树 A 主会话", { exact: true }).waitFor();
      for (const dropdown of [false, true]) {
        const open = () =>
          dropdown
            ? tree.getByRole("button", { name: "工作树操作" }).click()
            : tree.click({ button: "right" });
        await open();
        assert.deepEqual(await page.getByRole("menuitem").allTextContents(), [
          "新建空白会话",
          same,
          isolated,
          "打开工作树文件夹",
          "复制工作树路径",
          "工作树管理",
        ]);
        await page.waitForFunction(() => {
          const menu = [...document.querySelectorAll('[role="menu"]')].find(
            (node) => node.getBoundingClientRect().width > 0,
          );
          if (!menu) return false;
          const rect = menu.getBoundingClientRect();
          return (
            rect.left >= 0 &&
            rect.right <= innerWidth + 1 &&
            menu.scrollWidth <= menu.clientWidth + 1 &&
            [...menu.querySelectorAll('[role="menuitem"]')].every(
              (node) => node.scrollWidth <= node.clientWidth + 1,
            )
          );
        });
        if (!dropdown && process.env.LCODE_TEST_ARTIFACT_DIR) {
          await mkdir(process.env.LCODE_TEST_ARTIFACT_DIR, { recursive: true });
          await page.screenshot({
            path: join(process.env.LCODE_TEST_ARTIFACT_DIR, `worktree-menu-${width}.png`),
          });
        }
        await item(page, "新建空白会话").click();
        const request = JSON.parse(await page.getByTestId("create-request").innerText());
        assert.equal(request.targetWorkspace.workspacePath, "/fixture/repo");
        assert.equal(request.worktree.bindingId, "tree-a");
        assert.equal(request.worktree.bindingOwnerTaskId, "root-a");
        await open();
        await item(page, "复制工作树路径").click();
        assert.equal(await page.evaluate(() => globalThis.__copied), "/fixture/tree-a");
        await open();
        await item(page, "打开工作树文件夹").click();
        assert.equal(await page.getByTestId("opened-folder").innerText(), "/fixture/tree-a");
        for (const [name, mode] of [
          [same, "same"],
          [isolated, "worktree"],
        ]) {
          await open();
          await item(page, name).click();
          await page
            .getByTestId("selected-chat")
            .getByText(`child-root-a-${mode}`, { exact: true })
            .waitFor();
          const call = await page.evaluate(() =>
            globalThis.__worktreeSidebar.calls
              .filter((call) => call.method === "fork-command")
              .at(-1),
          );
          assert.equal(call.params.workspacePath, "/fixture/repo");
          assert.equal(call.params.envelope.sessionId, "root-a");
          assert.equal(call.params.envelope.payload.workspaceMode, mode);
          assert.equal(call.params.envelope.baseRevision, 7);
        }
        await page.evaluate(() => globalThis.__worktreeSidebar.setCanCreate(false));
        await open();
        await item(page, same).waitFor();
        await item(page, isolated, true).waitFor();
        assert.equal(
          await item(page, isolated, true).getAttribute("title"),
          "fixture-create-unavailable",
        );
        await page.keyboard.press("Escape");
        await page.evaluate(() => globalThis.__worktreeSidebar.setCanCreate(true));
      }
      await page.evaluate(() =>
        globalThis.__worktreeSidebar.setBindingStatus("tree-a", "archived"),
      );
      await tree.getByRole("img", { name: "目录已释放，快照可恢复", exact: true }).waitFor();
      await tree.click({ button: "right" });
      for (const name of ["新建空白会话", same, isolated, "打开工作树文件夹"])
        await item(page, name, true).waitFor();
      await item(page, "工作树管理").click();
      await page
        .getByTestId("worktree-settings-details")
        .getByRole("button", { name: "恢复工作树目录", exact: true })
        .waitFor();
      await page.getByTestId("fixture-close-settings").click();
      await page.evaluate(() => globalThis.__worktreeSidebar.setBindingStatus("tree-a", "ready"));
      await tree.getByRole("img", { name: "工作树可用", exact: true }).waitFor();
      await page.evaluate(() => globalThis.__worktreeSidebar.removeTask("root-a"));
      await page.getByText("树 A 主会话", { exact: true }).waitFor({ state: "detached" });
      await tree.click({ button: "right" });
      await item(page, same, true).waitFor();
      await item(page, isolated, true).waitFor();
      await item(page, "新建空白会话").waitFor();
      await page.keyboard.press("Escape");
      assert.equal(
        await tree
          .getByRole("button", { name: "worktree/task-a", exact: true })
          .getAttribute("aria-expanded"),
        "true",
      );
      assert.deepEqual(errors, []);
      await page.close();
    }
  },
);

test(
  "Worktree conversation context actions target that conversation without changing its checkout",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      page.setDefaultTimeout(10000);
      page.setDefaultNavigationTimeout(45000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "clipboard", {
          value: {
            writeText: async (text) => {
              globalThis.__copied = text;
            },
          },
        });
      });
      await page.goto(`http://127.0.0.1:${port}/test/fixtures/worktree-sidebar.html`);
      await page.getByTestId("sidebar-worktrees-tab").click();
      let title = "树 A 复用会话";
      const open = () => page.getByText(title, { exact: true }).click({ button: "right" });
      for (const [label, value] of [
        ["复制工作树路径", "/fixture/tree-a"],
        ["复制会话文件路径", "/sessions/fork-a.json"],
        ["复制日志路径", "/logs/fork-a.log"],
        ["复制会话 ID", "fork-a"],
      ]) {
        await open();
        await item(page, "复制信息").hover();
        await item(page, label).click();
        assert.equal(await page.evaluate(() => globalThis.__copied), value);
      }
      await open();
      await item(page, "更多操作").hover();
      await item(page, "在文件管理器中打开工作树").click();
      assert.equal(
        await page.evaluate(
          () =>
            globalThis.__worktreeSidebar.calls.find((call) => call.method === "open-folder").params
              .path,
        ),
        "/fixture/tree-a",
      );
      await open();
      await item(page, "更多操作").hover();
      await item(page, "查看调用轨迹").click();
      const trajectory = await page.evaluate(
        () => globalThis.__lcodeModelTrajectoryStoreE2E.getState().pendingRequest,
      );
      assert.equal(trajectory.taskId, "fork-a");
      assert.equal(trajectory.workspaceKey, "/fixture/repo");
      await open();
      await item(page, "反馈问题").click();
      const feedback = await page.evaluate(() => globalThis.__worktreeSidebar.facts().feedback);
      assert.match(feedback.description, /fork-a/);
      assert.equal(feedback.includeLogs, false);
      await open();
      await page.getByTestId("task-handoff").filter({ visible: true }).waitFor();
      assert.equal(await page.getByTestId("task-handoff").getAttribute("aria-disabled"), "true");
      assert.equal(
        await page.getByTestId("task-handoff-save").getAttribute("aria-disabled"),
        "true",
      );
      assert.equal(
        await page.getByRole("menuitem", { name: "在分屏打开", exact: true }).count(),
        0,
      );
      await page.getByTestId("task-fork-menu").hover();
      await page.getByTestId("task-fork-same").click();
      await page
        .getByTestId("selected-chat")
        .getByText("child-fork-a-same", { exact: true })
        .waitFor();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await open();
      await item(page, "重命名任务").click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("textbox").fill("修改后的子会话");
      await dialog.getByRole("button", { name: "确认", exact: true }).click();
      title = "修改后的子会话";
      await page.getByText(title, { exact: true }).waitFor();
      await open();
      await item(page, "标记为未读").click();
      await page.waitForFunction(
        () =>
          globalThis.__worktreeSidebar.facts().tasks.find((task) => task.taskId === "fork-a")
            .unreadAt > 0,
      );
      await open();
      await item(page, "置顶任务").click();
      await page.getByRole("heading", { name: "已置顶", exact: true }).waitFor();
      await open();
      await item(page, "取消置顶任务").click();
      // 上次打开的是会话菜单，下一次右键树行不能串入会话操作。
      await open();
      await page.keyboard.press("Escape");
      await page.locator('[data-binding-id="tree-a"]').click({ button: "right" });
      assert.equal(await page.getByRole("menuitem", { name: "归档任务", exact: true }).count(), 0);
      await page.keyboard.press("Escape");
      await page.evaluate(() =>
        globalThis.__worktreeSidebar.setBindingStatus("tree-a", "archived"),
      );
      await open();
      await item(page, "复制信息").hover();
      await item(page, "复制工作树路径", true).waitFor();
      await item(page, "更多操作").hover();
      await item(page, "在文件管理器中打开工作树", true).waitFor();
      await page.getByTestId("task-fork-menu").hover();
      await page.locator('[data-testid="task-fork-same"][data-disabled]').waitFor();
      await page.locator('[data-testid="task-fork-worktree"][data-disabled]').waitFor();
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await page.evaluate(() => globalThis.__worktreeSidebar.setBindingStatus("tree-a", "ready"));
      await page.evaluate(() => {
        globalThis.__worktreeSidebar.menuControl.failExecutionRead = true;
        globalThis.__worktreeSidebar.menuControl.sessionFileExists = false;
      });
      await open();
      await item(page, "复制信息").hover();
      await item(page, "复制日志路径").waitFor();
      await item(page, "复制工作树路径", true).waitFor();
      assert.equal(
        await page.getByRole("menuitem", { name: "复制会话文件路径", exact: true }).count(),
        0,
      );
      await page.keyboard.press("Escape");
      await page.evaluate(() => {
        globalThis.__worktreeSidebar.menuControl.failExecutionRead = false;
      });
      await open();
      await item(page, "归档任务").click();
      await page.getByText(title, { exact: true }).waitFor({ state: "detached" });
      const facts = await page.evaluate(() => globalThis.__worktreeSidebar.facts());
      assert.deepEqual(facts.bindingIds, ["tree-a", "tree-b"]);
      assert.equal(facts.bindings[0].status, "ready");
      await page.getByText("树 A 主会话", { exact: true }).waitFor();
      await page.getByText("树 B 会话", { exact: true }).waitFor();
      const calls = await page.evaluate(() => globalThis.__worktreeSidebar.calls);
      assert.equal(
        calls.some((call) => call.method === "archive"),
        false,
      );
      for (const method of ["rename-task", "unread-task", "pin-task", "archive-task"]) {
        const call = calls.find((call) => call.method === method);
        assert.equal(call.params.taskId, "fork-a");
        assert.equal(call.params.workspacePath, "/fixture/repo");
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  },
);
