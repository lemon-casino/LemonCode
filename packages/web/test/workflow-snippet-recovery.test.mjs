import assert from "node:assert/strict";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";
import { snippetBrowserData } from "./workflow-snippet-fixture-data.mjs";

test(
  "real snippet rejection and corrected result remain readable on desktop and phone",
  { timeout: 180000 },
  async (t) => {
    const data = await snippetBrowserData();
    assert.equal(data.executions, 1);
    assert.deepEqual(
      data.rows.map((row) => row.status),
      ["error", "error", "success"],
    );
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const errors = [];
    for (const width of [1280, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        isMobile: width === 390,
        hasTouch: width === 390,
      });
      try {
        await context.addInitScript(({ rows, executions }) => {
          window.__snippetRows = rows;
          window.__snippetExecutions = executions;
        }, data);
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${port}/test/fixtures/workflow-snippet-recovery.html`);
        for (const locale of ["zh-CN", "en-US"]) {
          if (locale === "en-US")
            await page.getByRole("button", { name: "zh-CN", exact: true }).click();
          for (const dark of [false, true]) {
            if (dark) await page.getByRole("button", { name: "Dark", exact: true }).click();
            for (const index of [0, 1, 2]) {
              const section = page.getByTestId(`snippet-case-${index}`);
              const trigger = section.locator('[role="button"][aria-expanded]').first();
              if ((await trigger.getAttribute("aria-expanded")) !== "true") {
                if (width === 390) await trigger.tap();
                else {
                  await trigger.focus();
                  await trigger.press("Enter");
                }
              }
              const expected =
                index === 0
                  ? "Neither `code` nor `path`"
                  : index === 1
                    ? "Both `code` and `path`"
                    : '"recovered": true';
              await section.getByText(expected, { exact: false }).first().waitFor();
              const text = await section.innerText();
              // CodeBlock 的编辑器可在 shadow DOM 内；父节点 innerText 不包含那里的正文。
              if (index < 2)
                await section
                  .getByText(/not executed/i)
                  .first()
                  .waitFor();
              assert.doesNotMatch(text, /Running workflow snippet|正在运行工作流片段/);
              if (index === 1)
                await section.getByText("REMOVE `path`", { exact: false }).first().waitFor();
              if (index < 2) assert.doesNotMatch(text, /\d+ms/);
            }
            assert.equal(await page.getByTestId("snippet-executions").innerText(), "1");
            assert.ok(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
              `overflow at ${width}, ${locale}, dark=${dark}`,
            );
            if (dark) await page.getByRole("button", { name: "Light", exact: true }).click();
          }
        }
        // 重载使用已序列化的真实结果，只恢复展示；CLI 端口计数保持为一次。
        await page.reload();
        const rejected = page.getByTestId("snippet-case-1");
        const trigger = rejected.locator('[role="button"][aria-expanded]').first();
        if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
        await rejected.getByText("Both `code` and `path`", { exact: false }).first().waitFor();
        assert.equal(await page.getByTestId("snippet-executions").innerText(), "1");
      } finally {
        await context.close();
      }
    }
    assert.deepEqual(errors, []);
  },
);
