import assert from "node:assert/strict";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test("Git 提交刷新不使会话目录与子智能体查看反复卸载", { timeout: 180_000 }, async (t) => {
  const { browser, port } = await startWorkflowProgressBrowser(t);
  for (const mode of ["local", "worktree"])
    for (const width of [1280, 390]) {
      await t.test(`${mode} ${width}px`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        page.setDefaultTimeout(10_000);
        const errors = [];
        page.on("pageerror", (error) => {
          errors.push(error.message);
          t.diagnostic(error.stack ?? error.message);
        });
        const api = (fn, arg) =>
          page.evaluate(([fn, arg]) => window.__sessionRefresh[fn](arg), [fn, arg]);
        const english = width === 390;
        try {
          await page.goto(
            `http://127.0.0.1:${port}/test/fixtures/git-session-refresh.html?${mode}${english ? "&english" : ""}`,
            { timeout: 30_000, waitUntil: "domcontentloaded" },
          );
          await page.waitForFunction(() => window.__sessionRefresh?.metrics().branch === "L-GO");
          const expectedPath = mode === "worktree" ? "/fixture/checkouts/parent" : "/fixture/repo";
          await page.getByTestId("execution").getByText(expectedPath, { exact: true }).waitFor();
          // 观察无文件事件的空闲窗口，旧版本会继续读会话、重建监听且闪烁。
          await page.waitForTimeout(1200);
          const baseline = await api("metrics");
          await page.waitForTimeout(1200);
          assert.equal(
            (await api("metrics")).sessionReads,
            baseline.sessionReads,
            "idle session reads must settle",
          );
          assert.equal(
            (await api("metrics")).watchStarts,
            baseline.watchStarts,
            "watch registrations must settle",
          );
          const status = page.getByTestId("status");
          await status.getByText(english ? "To-dos" : "待办", { exact: true }).waitFor();
          await status.getByText("2/4", { exact: true }).waitFor();
          const note = status.getByTestId("todo-execution-ended");
          assert.match(await note.textContent(), english ? /2.*to-dos/ : /2.*待办/);
          const agentSection = status.locator('[data-status-section="agent"]');
          await agentSection.locator('[data-slot="collapsible-trigger"]').click();
          await agentSection.getByRole("button", { name: english ? /Ended/ : /已结束/ }).click();
          const directory = page.getByTestId("directory");
          await directory.getByRole("button", { name: /Agent 1/ }).waitFor();
          await directory.getByRole("button", { name: /Agent 1/ }).click();
          assert.equal(await page.evaluate(() => window.__sessionRefresh.openedChild), "child-1");
          await page
            .getByTestId("child-transcript")
            .getByText("child-1: Provider returned a server error.", { exact: true })
            .waitFor();
          const beforeCommit = await api("metrics");
          await page.evaluate(() => {
            window.__keptDirectory = document.querySelector('[data-testid="directory"]');
            window.__keptAgentSection = document.querySelector('[data-status-section="agent"]');
          });
          await api("commit");
          await page.waitForFunction(
            (n) => window.__sessionRefresh.metrics().gitReads > n,
            beforeCommit.gitReads,
          );
          await page.waitForTimeout(1200);
          const afterCommit = await api("metrics");
          assert.equal(
            afterCommit.sessionReads,
            beforeCommit.sessionReads,
            "commit refresh must not re-read execution location",
          );
          assert.equal(afterCommit.watchStarts, beforeCommit.watchStarts);
          assert.equal(afterCommit.directoryMounts, beforeCommit.directoryMounts);
          assert.equal(afterCommit.agentOpen, true);
          assert.equal(
            await page.evaluate(
              () =>
                window.__keptDirectory === document.querySelector('[data-testid="directory"]') &&
                window.__keptAgentSection ===
                  document.querySelector('[data-status-section="agent"]'),
            ),
            true,
          );
          await directory.getByRole("button", { name: /Agent 2/ }).click();
          assert.equal(await page.evaluate(() => window.__sessionRefresh.openedChild), "child-2");
          await page
            .getByTestId("child-transcript")
            .getByText("child-2: Provider returned a server error.", { exact: true })
            .waitFor();
          for (const phase of ["running", "completedInterrupted", "error", "completedSuccess"]) {
            await api("phase", phase);
            if (phase === "running") await note.waitFor({ state: "detached" });
            else await note.waitFor();
            await status.getByText("2/4", { exact: true }).waitFor();
          }
          await api("historyOnly");
          await agentSection.getByRole("button", { name: english ? /Ended/ : /已结束/ }).waitFor();
          await api("collapse");
          const mini = status.locator('aside[data-state="collapsed"]');
          await mini.getByRole("button").click();
          await status.locator('aside[data-state="expanded"]').waitFor();
          await agentSection.getByRole("button", { name: english ? /Ended/ : /已结束/ }).waitFor();
          await api("invalidate");
          await page.waitForFunction(
            (n) => window.__sessionRefresh.metrics().sessionReads > n,
            afterCommit.sessionReads,
          );
          await page.getByTestId("execution").getByText(expectedPath, { exact: true }).waitFor();
          // 旧会话迟到结果不能把新会话的实际目录替换回来。
          await api("holdNextRead");
          await api("invalidate");
          await page.waitForFunction(() => window.__sessionRefresh.metrics().heldReads > 0);
          await api("switchTask", "second");
          const secondPath = mode === "worktree" ? "/fixture/checkouts/second" : expectedPath;
          await page.getByTestId("execution").getByText(secondPath, { exact: true }).waitFor();
          await api("releaseRead");
          await page.waitForTimeout(100);
          assert.equal((await api("metrics")).executionPath, secondPath);
          assert.deepEqual(errors, []);
        } catch (error) {
          t.diagnostic(
            JSON.stringify(
              await page.evaluate(() => ({
                metrics: window.__sessionRefresh.metrics(),
                error: window.__sessionRefresh.error,
                text: document.body.innerText,
              })),
            ),
          );
          throw error;
        } finally {
          await page.close();
        }
      });
    }
  await t.test("相同路径不同 Host 与同 endpoint 的 service 换代拒绝旧响应", async () => {
    const page = await browser.newPage();
    const api = (fn, arg) =>
      page.evaluate(([fn, arg]) => window.__remoteExecution[fn](arg), [fn, arg]);
    try {
      await page.goto(`http://127.0.0.1:${port}/test/fixtures/git-session-refresh.html?identity`, {
        timeout: 30_000,
        waitUntil: "domcontentloaded",
      });
      const output = page.getByTestId("remote-execution");
      await output.getByText("/fixture/execution/A", { exact: true }).waitFor();
      await api("hold");
      await api("invalidate");
      await page.waitForFunction(() => window.__remoteExecution.held() === 1);
      await output.getByText("pending", { exact: true }).waitFor();
      await api("switchHost", "B");
      await output.getByText("/fixture/execution/B", { exact: true }).waitFor();
      await api("release");
      await page.waitForTimeout(100);
      assert.equal(await output.textContent(), "/fixture/execution/B");
      await api("hold");
      await api("invalidate");
      await page.waitForFunction(() => window.__remoteExecution.held() === 2);
      await api("replaceService");
      await output.getByText("/fixture/execution/B2", { exact: true }).waitFor();
      await api("release");
      await page.waitForTimeout(100);
      assert.equal(await output.textContent(), "/fixture/execution/B2");
    } finally {
      await page.close();
    }
  });
});
