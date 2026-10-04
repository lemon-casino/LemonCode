import assert from "node:assert/strict";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "Git 审查来源隔离上游错误，保留本地列表并在恢复后清除诊断",
  { timeout: 120_000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const english of [false, true]) {
      for (const width of [1280, 390]) {
        await t.test(`${english ? "en-US" : "zh-CN"} / ${width}px`, async () => {
          const page = await browser.newPage({ viewport: { width, height: 800 } });
          page.setDefaultTimeout(10_000);
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          try {
            await page.goto(
              `http://127.0.0.1:${port}/test/fixtures/git-review-source-errors.html${english ? "?english" : ""}`,
            );
            const pane = page.locator("section[data-testid]");
            const errorTitle = english ? "Could not load Git changes" : "无法加载 Git 改动";
            const select = async (name) => {
              await pane.getByRole("combobox").click();
              await page.getByRole("option", { name, exact: true }).click();
            };
            const localSource = async (source) => {
              await select(
                english
                  ? source === "staged"
                    ? "Staged"
                    : "Unstaged"
                  : source === "staged"
                    ? "已暂存"
                    : "未暂存",
              );
              const row = pane.getByRole("button", { name: new RegExp(`${source}\\.txt`) });
              await row.waitFor();
              assert.equal(await pane.getByText(errorTitle, { exact: true }).count(), 0);
              await row.click();
              await pane.getByText(`${source} content`, { exact: true }).waitFor();
            };
            await pane.getByRole("button", { name: /unstaged\.txt/ }).waitFor();
            await localSource("staged");
            await localSource("unstaged");
            await select(english ? "All branch changes" : "全部分支更改");
            await pane.getByText(errorTitle, { exact: true }).waitFor();
            assert.match(await pane.innerText(), /bad revision 'origin\/L-GO\.\.\.HEAD'/);
            await localSource("staged");

            await page.evaluate(() => window.__gitReviewSourceFixture.setMode("recovered"));
            await select(english ? "All branch changes" : "全部分支更改");
            await pane.getByRole("button", { name: /branch\.txt/ }).waitFor();
            assert.equal(await pane.getByText(errorTitle, { exact: true }).count(), 0);

            // 旧 Host 不携带新增字段，来源切换仍使用同一共享组件。
            await page.evaluate(() => window.__gitReviewSourceFixture.setMode("legacy"));
            await localSource("unstaged");
            await page.evaluate(() => window.__gitReviewSourceFixture.setMode("status-failure"));
            await pane.getByText(errorTitle, { exact: true }).waitFor();
            assert.match(await pane.innerText(), /fixture local status failed/);
            await select(english ? "Staged" : "已暂存");
            await pane.getByText(errorTitle, { exact: true }).waitFor();
            assert.deepEqual(errors, []);
          } catch (error) {
            t.diagnostic(JSON.stringify({ errors, body: await page.locator("body").innerText() }));
            throw error;
          } finally {
            await page.close();
          }
        });
      }
    }
  },
);
