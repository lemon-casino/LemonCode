import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

// 验证真实侧栏入口、owner 读取 hook、任务聚合和管理/删除控制器；Host/Git 副作用由服务回归测试覆盖。
test(
  "Worktrees sidebar separates projects and chats and deletes only its selected binding",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${port}/test/fixtures/worktree-sidebar.html`);
      await page.getByText("普通任务", { exact: true }).waitFor();
      assert.equal(await page.getByText("树 A 主会话", { exact: true }).count(), 0);
      await page.getByTestId("sidebar-grouped-tab").click();
      assert.equal(await page.getByText("普通任务", { exact: true }).count(), 1);
      await page.evaluate(() => globalThis.__worktreeSidebar.publishTitles());
      await page.getByText("统一普通任务标题", { exact: true }).waitFor();
      await page.getByTestId("sidebar-workspace-tab").click();
      await page.getByText("统一普通任务标题", { exact: true }).waitFor();
      await page.getByTestId("sidebar-grouped-tab").click();
      await page.getByText("统一普通任务标题", { exact: true }).waitFor();
      await page.getByTestId("sidebar-worktrees-tab").click();
      await page
        .getByText("树 A 复用会话", { exact: true })
        .waitFor()
        .catch(async () =>
          assert.fail(
            JSON.stringify({
              errors,
              body: (await page.locator("body").innerText()).slice(0, 2000),
            }),
          ),
        );
      assert.equal(await page.getByTestId("sidebar-worktree").count(), 2);
      assert.equal(await page.getByText("普通任务", { exact: true }).count(), 0);
      await page.getByText("统一工作树任务标题", { exact: true }).waitFor();
      assert.equal(await page.getByText("worktree/task-a", { exact: true }).count(), 1);
      await page.getByText("树 A 复用会话", { exact: true }).click();
      await page.getByTestId("selected-chat").getByText("fork-a", { exact: true }).waitFor();
      await page.reload();
      await page.getByTestId("sidebar-worktrees-section").waitFor();
      await page.getByText("统一工作树任务标题", { exact: true }).waitFor();
      assert.equal(await page.getByText("worktree/task-a", { exact: true }).count(), 1);
      if (process.env.LCODE_TEST_ARTIFACT_DIR) {
        await mkdir(process.env.LCODE_TEST_ARTIFACT_DIR, { recursive: true });
        await page.screenshot({
          path: join(process.env.LCODE_TEST_ARTIFACT_DIR, `worktree-sidebar-${width}.png`),
        });
      }
      // 创建路径没有管理动作可挂失效通知：准备轮询读到 binding 后必须自己广播，
      // 列表在准备中与就绪两个阶段都自动收敛，不依赖用户点击刷新按钮。
      await page.evaluate(() => globalThis.__worktreeSidebar.startCreation());
      const created = page.locator('[data-binding-id="tree-new"]');
      await created
        .waitFor()
        .catch(async () =>
          assert.fail(
            JSON.stringify({
              errors,
              body: (await page.locator("body").innerText()).slice(0, 2000),
            }),
          ),
        );
      // 状态文案与原项目名在同一行，按子串匹配而不是整行精确匹配。
      await created.getByText(/正在准备工作树/).waitFor();
      assert.equal(await page.getByText("worktree/task-new", { exact: true }).count(), 1);
      await page.evaluate(() => globalThis.__worktreeSidebar.advanceCreation());
      await created.getByText(/工作树可用/).waitFor();
      await page.getByText("新工作树会话", { exact: true }).waitFor();
      await page.evaluate(() => globalThis.__worktreeSidebar.failNextDelete());
      await page
        .locator('[data-binding-id="tree-a"]')
        .getByRole("button", { name: "删除工作树", exact: true })
        .click();
      const confirmation = page.getByRole("alertdialog");
      await confirmation.getByTestId("worktree-discard-confirm").click();
      await confirmation.getByText("fixture EBUSY retry").waitFor();
      await confirmation.getByTestId("worktree-discard-confirm").click();
      await page.locator('[data-binding-id="tree-a"]').waitFor({ state: "detached" });
      assert.equal(await page.locator('[data-binding-id="tree-b"]').count(), 1);
      assert.equal(await page.locator('[data-binding-id="tree-new"]').count(), 1);
      await page.getByText("树 A 复用会话", { exact: true }).waitFor({ state: "detached" });
      await page.getByText("树 B 会话", { exact: true }).waitFor();
      const facts = await page.evaluate(() => globalThis.__worktreeSidebar.facts());
      assert.deepEqual(facts.bindingIds, ["tree-b", "tree-new"]);
      assert.deepEqual(facts.taskIds, ["ordinary", "root-b", "root-new"]);
      const calls = await page.evaluate(() => globalThis.__worktreeSidebar.calls);
      assert.equal(calls.length, 2);
      assert.deepEqual(calls.at(-1).params.discard, {
        branch: "worktree/task-a",
        checkoutPath: "/fixture/tree-a",
      });
      await page.getByTestId("sidebar-workspace-tab").click();
      await page.getByText("普通原项目", { exact: true }).waitFor();
      await page.getByText("统一普通任务标题", { exact: true }).waitFor();
      assert.deepEqual(errors, []);
      await page.close();
    }
  },
);
