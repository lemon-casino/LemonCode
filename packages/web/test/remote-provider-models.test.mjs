import assert from "node:assert/strict";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

const providers = [
  ["openai", "OpenAI"],
  ["oauth:copilot", "GitHub Copilot"],
  ["oauth:workbuddy-ai", "WorkBuddy AI"],
  ["oauth:codex", "OpenAI Codex"],
  ["oauth:antigravity", "Google Antigravity"],
  ["oauth:workbuddy", "WorkBuddy"],
];

test("远端目录同时展示 API/OAuth 供应商并按选择冻结发送模型", { timeout: 180000 }, async (t) => {
  const { browser, port } = await startWorkflowProgressBrowser(t);
  for (const width of [1280, 390]) {
    for (const english of [false, true]) {
      for (const existing of [false, true]) {
        await t.test(
          `${width}px ${english ? "en" : "zh"} ${existing ? "继续发送" : "首发"}`,
          async () => {
            const page = await browser.newPage({ viewport: { width, height: 844 } });
            page.setDefaultTimeout(10000);
            const errors = [];
            page.on("pageerror", (error) => errors.push(error.message));
            try {
              const query = new URLSearchParams({ remoteProviders: "1" });
              if (english) query.set("english", "1");
              if (existing) query.set("existing", "1");
              await page.goto(
                `http://127.0.0.1:${port}/test/fixtures/conversation-send.html?${query}`,
              );
              for (const [index, [id, name]] of providers.entries()) {
                const trigger = page.getByTestId("chat-model-select-trigger");
                await trigger.click();
                assert.equal(await page.locator("[data-model-provider-key]").count(), 6);
                const group = page
                  .locator("[data-model-provider-key]")
                  .filter({ hasText: new RegExp(`^${name}$`) });
                await group.click();
                await group.press("ArrowRight");
                await page.getByRole("menuitemradio", { name: "demo", exact: true }).click();
                await trigger.locator('xpath=self::*[@aria-expanded="false"]').waitFor();
                await page.getByTestId("v4-composer-input").fill(`remote provider ${index}`);
                await page.waitForFunction(
                  () => !document.querySelector('[data-testid="v4-composer-send"]')?.disabled,
                );
                await page.getByTestId("v4-composer-send").click();
                await page.waitForFunction(
                  (count) => globalThis.__sendFixture.calls.length === count,
                  index + 1,
                );
                const call = await page.evaluate(
                  (index) => globalThis.__sendFixture.calls[index],
                  index,
                );
                assert.equal(call.options.submission.modelSelection.providerId, id);
                assert.equal(call.options.submission.modelSelection.modelId, "demo");
              }
              assert.deepEqual(errors, []);
            } finally {
              await page.close();
            }
          },
        );
      }
    }
  }
});
