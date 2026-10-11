import assert from "node:assert/strict";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test("会话速度菜单按目录展示并冻结提交档位", { timeout: 180_000 }, async (t) => {
  const { browser, port } = await startWorkflowProgressBrowser(t);
  for (const width of [1280, 390]) {
    for (const existing of [false, true]) {
      for (const standardOnly of [false, true]) {
        await t.test(
          `${width}px ${existing ? "已有会话" : "新会话"} ${standardOnly ? "仅标准" : "快速可选"}`,
          async () => {
            const page = await browser.newPage({ viewport: { width, height: 800 } });
            try {
              const query = new URLSearchParams();
              if (existing) query.set("existing", "");
              if (standardOnly) query.set("standardOnly", "");
              await page.goto(
                `http://127.0.0.1:${port}/test/fixtures/conversation-send.html?${query}`,
              );
              await page.getByTestId("chat-model-speed-trigger").click();
              await page.getByTestId("chat-model-speed-standard").waitFor();
              assert.equal(
                await page.getByTestId("chat-model-speed-fast").count(),
                standardOnly ? 0 : 1,
              );
              await page.getByTestId("chat-model-speed-standard").click();
              const editor = page.getByTestId("v4-composer-input");
              await editor.fill("speed regression");
              await page.waitForFunction(
                () => !document.querySelector('[data-testid="v4-composer-send"]')?.disabled,
              );
              await page.getByTestId("v4-composer-send").click();
              await page.waitForFunction(() => globalThis.__sendFixture.calls.length === 1);
              const [call] = await page.evaluate(() => globalThis.__sendFixture.calls);
              assert.deepEqual(call.options.submission.modelSelection.options, {
                reasoningLevel: "high",
                speed: "standard",
              });
            } finally {
              await page.close();
            }
          },
        );
      }
    }
  }
});
