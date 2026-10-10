import assert from "node:assert/strict";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "file tree remains accessible when the active session cannot be read",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const width of [1280, 390]) {
      await t.test(`${width}px: cold session, view switching and file errors`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 844 } });
        page.setDefaultTimeout(7000);
        const errors = [];
        page.on("pageerror", (error) => {
          errors.push(error.message);
          t.diagnostic(error.message);
        });
        const english = width === 390;
        await page.goto(
          `http://127.0.0.1:${port}/test/fixtures/sidebar-file-tree.html${english ? "?english&light" : ""}`,
        );
        await page
          .getByTestId("execution-error")
          .getByText(/Session is not active/)
          .waitFor();
        await page.getByTestId("sidebar-workspace-tab").click();
        const project = page.getByTestId("workspace-list");
        await project.locator('[role="button"]').first().hover();
        await page
          .getByRole("button", { name: english ? "Show files" : "查看文件", exact: true })
          .click();
        const back = page.getByRole("button", {
          name: english ? "Back to tasks" : "返回任务",
          exact: true,
        });
        await back.waitFor();
        await page.getByText("local.ts", { exact: true }).waitFor();
        assert.equal(await page.evaluate(() => globalThis.__sidebarFiles.facts.newTasks), 0);
        assert.equal(
          await page.evaluate(() => globalThis.__sidebarFiles.activeTask()),
          "cold-session",
        );
        for (const mode of ["grouped", "worktrees", "workspace"]) {
          await back.click();
          await page.getByTestId(`sidebar-${mode}-tab`).click();
          await page.evaluate(() =>
            globalThis.__sidebarFiles.open({
              workspacePath: "/fixture/other",
              workspaceName: "Other",
            }),
          );
          await page.getByText("local.ts", { exact: true }).waitFor();
          assert.equal(
            (await page.evaluate(() => globalThis.__sidebarFiles.calls)).at(-1).path,
            "/fixture/other",
          );
        }
        await back.click();
        await page.evaluate(() => {
          globalThis.__sidebarFiles.failFiles(true);
          globalThis.__sidebarFiles.open({
            workspacePath: "/fixture/unreadable",
            workspaceName: "Unreadable",
          });
        });
        await page.getByText("fixture file permission denied", { exact: true }).waitFor();
        await back.waitFor();
        await page.evaluate(() => globalThis.__sidebarFiles.failFiles(false));
        await page
          .getByRole("button", { name: english ? "Refresh file tree" : "刷新文件树", exact: true })
          .click();
        await page.getByText("local.ts", { exact: true }).waitFor();
        await back.click();
        await page.getByTestId("sidebar-workspace-tab").waitFor({ state: "visible" });
        assert.equal(
          await page.evaluate(() => globalThis.__sidebarFiles.activeTask()),
          "cold-session",
        );
        assert.deepEqual(errors, []);
        await page.close();
      });
    }
    await t.test("a known worktree binding still maps files without a live session", async () => {
      const page = await browser.newPage();
      page.setDefaultTimeout(7000);
      await page.goto(`http://127.0.0.1:${port}/test/fixtures/sidebar-file-tree.html?worktree`);
      await page
        .getByTestId("execution-error")
        .getByText(/Session is not active/)
        .waitFor();
      await page.evaluate(() =>
        globalThis.__sidebarFiles.open({
          workspacePath: "/fixture/file-project",
          workspaceName: "Tree",
        }),
      );
      await page.getByText("local.ts", { exact: true }).waitFor();
      assert.equal(
        (await page.evaluate(() => globalThis.__sidebarFiles.calls)).at(-1).path,
        "/fixture/file-checkout",
      );
      await page.getByRole("button", { name: "返回任务", exact: true }).click();
      await page.close();
    });
    await t.test("pending session reads do not block browsing", async () => {
      const page = await browser.newPage();
      page.setDefaultTimeout(7000);
      await page.goto(`http://127.0.0.1:${port}/test/fixtures/sidebar-file-tree.html?pending`);
      await page.waitForFunction(() => globalThis.__sidebarFiles?.facts.sessionReads > 0);
      await page.evaluate(() =>
        globalThis.__sidebarFiles.open({ workspacePath: "/fixture/other", workspaceName: "Other" }),
      );
      await page.getByText("local.ts", { exact: true }).waitFor();
      assert.equal(await page.getByTestId("execution-error").textContent(), "pending");
      await page.getByRole("button", { name: "返回任务", exact: true }).click();
      await page.close();
    });
    await t.test(
      "same-path remote targets keep their attachment and disconnected targets never read locally",
      async () => {
        const page = await browser.newPage();
        page.setDefaultTimeout(7000);
        await page.goto(`http://127.0.0.1:${port}/test/fixtures/sidebar-file-tree.html`);
        await page
          .getByTestId("execution-error")
          .getByText(/Session is not active/)
          .waitFor();
        for (const index of [0, 1]) {
          await page.evaluate(
            (index) =>
              globalThis.__sidebarFiles.open(globalThis.__sidebarFiles.remoteTargets[index]),
            index,
          );
          await page.getByText(`remote-${index === 0 ? "a" : "b"}.ts`, { exact: true }).waitFor();
          const call = (await page.evaluate(() => globalThis.__sidebarFiles.calls)).at(-1);
          assert.deepEqual(call, {
            endpoint: `remote-${index === 0 ? "a" : "b"}`,
            path: "/fixture/file-project",
          });
        }
        const before = await page.evaluate(() => globalThis.__sidebarFiles.calls.length);
        await page.evaluate(() => {
          globalThis.__sidebarFiles.disconnect("remote-b");
          globalThis.__sidebarFiles.open(globalThis.__sidebarFiles.remoteTargets[1]);
        });
        await page.getByText("LCODE_REMOTE_WORKSPACE_DISCONNECTED", { exact: true }).waitFor();
        assert.equal(await page.evaluate(() => globalThis.__sidebarFiles.calls.length), before);
        await page.getByRole("button", { name: "返回任务", exact: true }).click();
        assert.equal(await page.evaluate(() => globalThis.__sidebarFiles.facts.newTasks), 0);
        await page.close();
      },
    );
  },
);
