import assert from "node:assert/strict";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test("会话各轮历史审查与及时 Git 刷新使用共享 hooks", { timeout: 120_000 }, async (t) => {
  const { browser, port } = await startWorkflowProgressBrowser(t);
  for (const english of [false, true])
    for (const width of [1280, 390]) {
      await t.test(`${english ? "en" : "zh"} ${width}px`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 820 } });
        page.setDefaultTimeout(10_000);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const api = async (fn, arg) =>
          page.evaluate(([fn, arg]) => window.__liveReview[fn](arg), [fn, arg]);
        try {
          await page.goto(
            `http://127.0.0.1:${port}/test/fixtures/git-review-live-turns.html${english ? (width === 390 ? "?english&linux" : "?english") : ""}`,
            { timeout: 30_000, waitUntil: "domcontentloaded" },
          );
          const pane = page.locator("section[data-testid]");
          const select = async (name) => {
            await pane.getByRole("combobox").click();
            await page.getByRole("option", { name, exact: true }).click();
          };
          const review = english ? "Review" : "审查";
          await pane.getByRole("button", { name: /turn-1-0\.txt/ }).waitFor();
          assert.equal((await api("metrics")).files, 48);
          assert.equal(
            (await api("metrics")).subscriptions,
            1,
            "StrictMode remount shares session subscription",
          );
          assert.equal(
            await page
              .getByTestId("next-turn")
              .getByRole("button", { name: review, exact: true })
              .isDisabled(),
            true,
          );
          await page
            .getByTestId("previous-turn")
            .getByRole("button", { name: review, exact: true })
            .click();
          await pane
            .getByRole("combobox")
            .getByText(english ? "Selected turn changes" : "所选轮次改动")
            .waitFor();
          await api("finish", "completedSuccess");
          assert.equal((await api("metrics")).files, 48, "explicit selection remains on old turn");
          const initialReads = (await api("metrics")).detailReads;
          const initialCompleted = (await api("metrics")).detailCompleted;
          await api("delayDetails", 800);
          await page
            .getByTestId("next-turn")
            .getByRole("button", { name: review, exact: true })
            .click();
          await page.waitForFunction(
            (count) => window.__liveReview.metrics().detailReads > count,
            initialReads,
          );
          await api("delayDetails", 0);
          await page
            .getByTestId("previous-turn")
            .getByRole("button", { name: review, exact: true })
            .click();
          await pane.getByRole("button", { name: /turn-1-0\.txt/ }).waitFor();
          await page.waitForFunction(
            (count) => window.__liveReview.metrics().detailCompleted >= count + 2,
            initialCompleted,
          );
          assert.equal(
            (await api("metrics")).files,
            48,
            "late response from another turn is ignored",
          );
          await pane
            .getByRole("button", {
              name: english ? "View last turn changes" : "查看上一轮改动",
              exact: true,
            })
            .click();
          await pane.getByRole("button", { name: /turn-4-0\.txt/ }).waitFor();
          await page
            .getByTestId("next-turn")
            .getByRole("button", { name: review, exact: true })
            .click();
          await pane.getByRole("button", { name: /turn-4-0\.txt/ }).click();
          await pane.getByText("historical turn 4", { exact: true }).waitFor();
          assert.equal((await api("metrics")).files, 1);
          await select(english ? "Unstaged" : "未暂存");
          await pane.getByRole("button", { name: /current\.txt/ }).waitFor();
          await api("phase", "staged");
          await pane
            .getByText(english ? "No unstaged changes" : "当前没有未暂存的改动", { exact: true })
            .waitFor();
          await select(english ? "Staged" : "已暂存");
          await pane.getByRole("button", { name: /current\.txt/ }).waitFor();
          await api("phase", "committed");
          await pane
            .getByText(english ? "No staged changes" : "当前没有已暂存的改动", { exact: true })
            .waitFor();
          await select(english ? "Last turn" : "上一轮更改");
          await pane.getByRole("button", { name: /turn-4-0\.txt/ }).waitFor();
          await api("finish", "completedInterrupted");
          await pane
            .getByText(
              english
                ? "The latest finished turn has no file changes"
                : "最近一轮已结束的任务没有文件改动",
              { exact: true },
            )
            .waitFor();
          await api("finish", "completedSuccess");
          await api("failure", true);
          await pane.getByText(/fixture historical query failed/).waitFor();
          await api("failure", false);
          await pane.getByRole("button", { name: /turn-4-0\.txt/ }).waitFor();
          const before = (await api("metrics")).refreshes;
          const historyReadsBefore = (await api("metrics")).detailReads;
          await api("slow", 900);
          // 4s 连续文件事件：若尾沿防抖无限延迟或不断取消响应，就不会在批次中刷新。
          await page.evaluate(async () => {
            const start = Date.now();
            while (Date.now() - start < 4000) {
              window.__liveReview.phase("unstaged");
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          });
          assert.ok(
            (await api("metrics")).refreshes > before,
            "continuous changes refresh before batch ends",
          );
          await select(english ? "Unstaged" : "未暂存");
          await pane.getByRole("button", { name: /current\.txt/ }).waitFor();
          assert.equal((await api("metrics")).maxInFlight, 1, "slow Git refreshes are serialized");
          assert.equal(
            (await api("metrics")).detailReads,
            historyReadsBefore,
            "automatic Git refresh does not reread historical patches",
          );
          assert.deepEqual(errors, []);
        } catch (error) {
          t.diagnostic(JSON.stringify({ errors, text: await page.locator("body").innerText() }));
          throw error;
        } finally {
          await page.close();
        }
      });
    }
});
