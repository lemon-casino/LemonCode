import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "右侧面板的切换、打开、审查保留加载/错误入口并等待冷会话恢复",
  { timeout: 180_000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    await mkdir(".artifacts/side-pane-recovery", { recursive: true });
    for (const width of [1280, 390])
      for (const action of ["toggle", "open", "review"]) {
        await t.test(`${width}px ${action}`, async () => {
          const page = await browser.newPage({ viewport: { width, height: 820 } });
          page.setDefaultTimeout(10_000);
          const english = width === 390;
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          const metrics = () => page.evaluate(() => window.__sideRecovery.metrics());
          try {
            await page.goto(
              `http://127.0.0.1:${port}/test/fixtures/side-pane-recovery.html?${english ? "english&worktree" : "local"}`,
              { waitUntil: "domcontentloaded", timeout: 30_000 },
            );
            await page.waitForFunction(
              () => window.__sideRecovery?.metrics().subscribeAttempts === 1,
            );
            // 测真实按钮，而非直接把 React 状态设成 open。
            if (action === "toggle")
              await page.getByTestId("recovery-header").getByRole("button").click();
            else
              await page
                .getByRole("button", { name: action === "open" ? "打开" : "审查", exact: true })
                .click();
            const panel = page.locator("[data-workspace-side-pane-panel]");
            const loading = page.getByTestId("side-pane-execution-loading");
            await loading.waitFor();
            assert.equal(
              (await metrics()).earlyReads,
              0,
              "readSession must wait for shared cold resume",
            );
            assert.equal(await page.getByTestId("recovery-header").getByRole("button").count(), 1);
            await page.waitForFunction(
              () =>
                document.querySelector("[data-workspace-side-pane-panel]")?.getBoundingClientRect()
                  .width >= 240,
            );
            await page.evaluate(() => {
              window.__keptSidePanel = document.querySelector("[data-workspace-side-pane-panel]");
              window.__sideRecovery.ready();
            });
            await loading.waitFor({ state: "detached" });
            const expectedPath = english ? "/fixture/checkouts/parent" : "/fixture/repo";
            await page.waitForFunction(
              (path) => window.__sideRecovery.metrics().path === path,
              expectedPath,
            );
            assert.equal(
              (await metrics()).subscribes,
              1,
              "chat and execution hook share one subscription",
            );
            if (action === "open")
              await panel.getByText("Preview content", { exact: true }).waitFor();
            if (action === "review") await panel.locator('[role="combobox"]').waitFor();
            await page.evaluate(() => window.__sideRecovery.failRead());
            const failure = page.getByTestId("side-pane-execution-error");
            await failure.waitFor();
            assert.equal(await page.getByTestId("recovery-header").getByRole("button").count(), 1);
            assert.equal(
              await page.evaluate(
                () =>
                  window.__keptSidePanel ===
                  document.querySelector("[data-workspace-side-pane-panel]"),
              ),
              true,
            );
            if (english)
              await panel.getByRole("button", { name: "Collapse side pane", exact: true }).click();
            else await page.getByTestId("recovery-header").getByRole("button").click();
            await page.waitForFunction(() => !window.__sideRecovery.metrics().open);
            await page.getByTestId("recovery-header").getByRole("button").click();
            await failure.waitFor();
            await page.evaluate(() => window.__sideRecovery.repair());
            await failure
              .getByRole("button", { name: english ? "Retry" : "重试", exact: true })
              .click();
            await failure.waitFor({ state: "detached" });
            await page.waitForFunction(
              (path) => window.__sideRecovery.metrics().path === path,
              expectedPath,
            );
            if (action === "open")
              await panel.getByText("Preview content", { exact: true }).waitFor();
            if (action === "review") await panel.locator('[role="combobox"]').waitFor();
            const before = await metrics();
            await page.evaluate(() => window.__sideRecovery.refresh());
            await page.waitForFunction(
              (n) => window.__sideRecovery.metrics().gitReads > n,
              before.gitReads,
            );
            assert.equal(
              (await metrics()).sessionReads,
              before.sessionReads,
              "Git refresh never invalidates execution",
            );
            await page.screenshot({ path: `.artifacts/side-pane-recovery/${width}-${action}.png` });
            assert.deepEqual(errors, []);
          } catch (error) {
            t.diagnostic(
              JSON.stringify({
                action,
                width,
                metrics: await metrics(),
                errors,
                text: (await page.locator("body").innerText()).slice(0, 1200),
              }),
            );
            throw error;
          } finally {
            await page.close();
          }
        });
      }
    for (const width of [1280, 390])
      await t.test(`${width}px subscription failure retries shared recovery`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 820 } });
        page.setDefaultTimeout(10_000);
        const english = width === 390;
        try {
          await page.goto(
            `http://127.0.0.1:${port}/test/fixtures/side-pane-recovery.html?fail-subscribe${english ? "&english&worktree" : ""}`,
            { waitUntil: "domcontentloaded", timeout: 30_000 },
          );
          await page.waitForFunction(() => window.__sideRecovery?.metrics().error);
          await page.getByRole("button", { name: "打开", exact: true }).click();
          const failure = page.getByTestId("side-pane-execution-error");
          await failure.waitFor();
          assert.equal(await page.getByTestId("recovery-header").getByRole("button").count(), 1);
          assert.equal(await page.evaluate(() => window.__sideRecovery.metrics().earlyReads), 0);
          await page.evaluate(() => window.__sideRecovery.repair());
          await failure
            .getByRole("button", { name: english ? "Retry" : "重试", exact: true })
            .click();
          await page
            .locator("[data-workspace-side-pane-panel]")
            .getByText("Preview content", { exact: true })
            .waitFor();
          assert.equal(
            await page.evaluate(() => window.__sideRecovery.metrics().subscribeAttempts),
            2,
          );
        } finally {
          await page.close();
        }
      });
  },
);
