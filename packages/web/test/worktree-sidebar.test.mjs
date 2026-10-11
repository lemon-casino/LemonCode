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
      const treeA = page.locator('[data-binding-id="tree-a"]');
      await treeA.getByRole("button", { name: "worktree/task-a", exact: true }).click();
      assert.equal(await page.getByText("树 A 复用会话", { exact: true }).isVisible(), false);
      assert.equal(await page.getByText("树 B 会话", { exact: true }).isVisible(), true);
      await page.reload();
      await page.getByTestId("sidebar-worktrees-section").waitFor();
      await treeA.waitFor();
      assert.equal(
        await treeA
          .getByRole("button", { name: "worktree/task-a", exact: true })
          .getAttribute("aria-expanded"),
        "false",
      );
      await treeA.getByRole("button", { name: "worktree/task-a", exact: true }).click();
      await page.getByText("统一工作树任务标题", { exact: true }).waitFor();
      assert.equal(await page.getByText("worktree/task-a", { exact: true }).count(), 1);
      assert.ok(
        (await treeA.boundingBox()).height <= 34,
        "worktree header stays on one compact line",
      );
      assert.equal(await treeA.getByText("/fixture/tree-a", { exact: true }).count(), 0);
      await treeA.getByRole("button", { name: "打开工作树文件夹" }).click();
      await page
        .getByTestId("opened-folder")
        .getByText("/fixture/tree-a", { exact: true })
        .waitFor();
      await treeA.getByRole("button", { name: "新建空白会话", exact: true }).click();
      const createRequest = JSON.parse(await page.getByTestId("create-request").innerText());
      assert.equal(createRequest.targetWorkspace.workspacePath, "/fixture/repo");
      assert.deepEqual(createRequest.worktree, {
        bindingId: "tree-a",
        bindingOwnerTaskId: "root-a",
        label: "worktree/task-a",
      });
      assert.equal(await treeA.getByText("在此工作树分支会话", { exact: true }).count(), 0);
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
      await created.waitFor().catch(async () =>
        assert.fail(
          JSON.stringify({
            errors,
            body: (await page.locator("body").innerText()).slice(0, 2000),
          }),
        ),
      );
      await created.getByRole("img", { name: /正在准备工作树/ }).waitFor();
      assert.equal(await page.getByText("worktree/task-new", { exact: true }).count(), 1);
      await page.evaluate(() => globalThis.__worktreeSidebar.advanceCreation());
      await created.getByRole("img", { name: /工作树可用/ }).waitFor();
      await page.getByText("新工作树会话", { exact: true }).waitFor();
      await page.evaluate(() => globalThis.__worktreeSidebar.failNextDelete());
      await treeA.click({ button: "right" });
      await page.getByRole("menuitem", { name: "在同一工作树中创建会话分叉" }).waitFor();
      await page.getByRole("menuitem", { name: "工作树管理", exact: true }).click();
      const settings = page.getByTestId("settings-worktrees-section");
      await settings.getByTestId("worktree-settings-details").waitFor();
      assert.equal(await page.getByRole("dialog").count(), 0, "management lives in settings");
      await settings.getByTestId("worktree-discard").click();
      const confirmation = page.getByRole("alertdialog");
      await confirmation.getByTestId("worktree-discard-confirm").click();
      await confirmation.getByText("fixture EBUSY retry").waitFor();
      await confirmation.getByTestId("worktree-discard-confirm").click();
      await settings.getByTestId("worktree-settings-list").waitFor();
      await page.getByTestId("fixture-close-settings").click();
      await page.locator('[data-binding-id="tree-a"]').waitFor({ state: "detached" });
      assert.equal(await page.locator('[data-binding-id="tree-b"]').count(), 1);
      assert.equal(await page.locator('[data-binding-id="tree-new"]').count(), 1);
      await page.getByText("树 A 复用会话", { exact: true }).waitFor({ state: "detached" });
      await page.getByText("树 B 会话", { exact: true }).waitFor();
      const facts = await page.evaluate(() => globalThis.__worktreeSidebar.facts());
      assert.deepEqual(facts.bindingIds, ["tree-b", "tree-new"]);
      assert.deepEqual(facts.taskIds, ["ordinary", "root-b", "root-new"]);
      const calls = await page.evaluate(() =>
        globalThis.__worktreeSidebar.calls.filter((call) => call.method === "archive"),
      );
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

test(
  "Coding settings edit worktrees and environments inline at desktop and mobile widths",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${port}/test/fixtures/worktree-sidebar.html`);
      await page.getByTestId("sidebar-worktrees-tab").click();
      await page
        .locator('[data-binding-id="tree-a"]')
        .getByRole("button", { name: "工作树操作" })
        .click();
      await page.getByRole("menuitem", { name: "工作树管理", exact: true }).click();
      const settings = page.getByTestId("settings-worktrees-section");
      const general = page.getByTestId("worktree-general-settings");
      await general.getByRole("switch", { name: "自动删除旧工作树" }).click();
      await page.waitForFunction(
        () => !globalThis.__worktreeSidebar.facts().managementSettings.autoDeleteEnabled,
      );
      const count = general.getByRole("spinbutton", { name: "自动删除限制" });
      await count.fill("0");
      assert.equal(
        await general.getByRole("button", { name: "保存", exact: true }).isDisabled(),
        true,
      );
      await count.fill("3");
      await general.getByRole("button", { name: "保存", exact: true }).click();
      await page.waitForFunction(
        () => globalThis.__worktreeSidebar.facts().managementSettings.retainedCount === 3,
      );
      await general.getByRole("combobox", { name: "工作树根目录", exact: true }).click();
      await page.getByRole("option", { name: "项目内 .lcode", exact: true }).click();
      await page.waitForFunction(
        () => globalThis.__worktreeSidebar.facts().managementSettings.rootLocation === "project",
      );
      await general.getByRole("combobox", { name: "工作树根目录", exact: true }).click();
      await page.getByRole("option", { name: "自定义目录", exact: true }).click();
      await general
        .getByRole("textbox", { name: "自定义工作树根目录" })
        .fill("/fixture/custom trees");
      await general.getByRole("button", { name: "保存", exact: true }).last().click();
      await page.waitForFunction(
        () =>
          globalThis.__worktreeSidebar.facts().managementSettings.rootDirectory ===
          "/fixture/custom trees",
      );
      assert.equal(await page.getByRole("dialog").count(), 0);
      if (process.env.LCODE_TEST_ARTIFACT_DIR) {
        await mkdir(process.env.LCODE_TEST_ARTIFACT_DIR, { recursive: true });
        await page.screenshot({
          path: join(process.env.LCODE_TEST_ARTIFACT_DIR, `worktree-settings-${width}.png`),
          fullPage: true,
        });
      }
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        "settings do not overflow horizontally",
      );
      const details = settings.getByTestId("worktree-settings-details");
      await details.getByRole("textbox", { name: "工作树名称" }).fill("功能开发");
      await details.getByRole("button", { name: "保存", exact: true }).click();
      await page.waitForFunction(
        () => globalThis.__worktreeSidebar.facts().bindings[0].displayName === "功能开发",
      );
      await details.getByRole("button", { name: "保存快照并释放目录", exact: true }).click();
      await details.getByTestId("worktree-archive-success").waitFor();
      await details.getByRole("button", { name: "恢复工作树目录", exact: true }).click();
      await details.getByRole("button", { name: "保存快照并释放目录", exact: true }).waitFor();
      await details.getByRole("button", { name: "环境", exact: true }).click();
      const environment = page.getByTestId("settings-environments-section");
      await environment.getByTestId("runtime-environment-unmanaged").waitFor();
      await environment.getByRole("combobox", { name: "新工作树的运行环境", exact: true }).click();
      await page.getByRole("option", { name: "托管环境", exact: true }).click();
      await page.waitForFunction(
        () =>
          globalThis.__worktreeSidebar.facts().executionSettings.projectExecutionPreferences?.[
            "/fixture/repo"
          ]?.environmentPolicy === "managed",
      );
      // 默认策略仅作用于后续新树；已有树仍展示 owner 返回的本机环境。
      await environment.getByTestId("runtime-environment-unmanaged").waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (process.env.LCODE_TEST_ARTIFACT_DIR)
        await page.screenshot({
          path: join(process.env.LCODE_TEST_ARTIFACT_DIR, `worktree-environments-${width}.png`),
          fullPage: true,
        });
      await page
        .getByRole("navigation", { name: "编码" })
        .getByRole("button", { name: "工作树管理", exact: true })
        .click();
      await settings.getByRole("button", { name: "返回列表", exact: true }).click();
      await settings.getByRole("textbox", { name: "搜索工作树" }).fill("功能开发");
      assert.equal(
        await settings.getByTestId("worktree-settings-list").getByRole("button").count(),
        1,
      );
      await page.getByTestId("fixture-close-settings").click();
      await page
        .locator('[data-binding-id="tree-a"]')
        .getByRole("button", { name: "功能开发", exact: true })
        .waitFor();
      assert.deepEqual(errors, []);
      await page.close();
    }
  },
);
