import assert from "node:assert/strict";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "model sync preserves configuration on local errors and only disables confirmed invalid models",
  { timeout: 120_000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const width of [1280, 390]) {
      for (const localError of [true, false]) {
        await t.test(
          `${width}px ${localError ? "local configuration error" : "upstream results"}`,
          async () => {
            const page = await browser.newPage({ viewport: { width, height: 844 } });
            page.setDefaultTimeout(15_000);
            const errors = [];
            page.on("pageerror", (error) => errors.push(error.message));
            try {
              await page.goto(
                `http://127.0.0.1:${port}/test/fixtures/model-provider-settings.html${localError ? "?localProbeError=1" : ""}`,
              );
              if (width === 390) {
                await page.getByLabel("Language", { exact: true }).selectOption("en-US");
                await page.getByLabel("Theme", { exact: true }).selectOption("zai-light");
              }
              const configuration = page.getByTestId("fixture-configuration");
              await page.waitForFunction(
                () =>
                  JSON.parse(
                    document.querySelector('[data-testid="fixture-configuration"]').textContent,
                  ).models.length > 0,
              );
              const before = JSON.parse(await configuration.textContent());
              await page
                .getByRole("button", {
                  name: width === 390 ? "Sync models" : "同步模型",
                  exact: true,
                })
                .click();
              const dialog = page.getByTestId("model-provider-sync-models-dialog");
              assert.match(
                await dialog.textContent(),
                width === 390
                  ? /other errors preserve their enabled state/
                  : /其他错误保留原启用状态/,
              );
              await dialog.getByText("remote-a", { exact: true }).waitFor();
              await dialog.getByRole("button", { name: /检测并添加|Check and add/ }).click();
              await page.waitForFunction(() => {
                const button = document.querySelector(
                  '[data-testid="model-provider-sync-models-dialog"] button[data-slot="button"]',
                );
                const text =
                  document.querySelector('[data-testid="model-provider-sync-models-dialog"]')
                    ?.textContent ?? "";
                return button && !button.disabled && /检测失败|Check failed/.test(text);
              });
              const after = JSON.parse(await configuration.textContent());
              if (localError) {
                assert.deepEqual(after, before);
                assert.match(
                  await dialog.textContent(),
                  /Fixture local proxy configuration unavailable/,
                );
                assert.doesNotMatch(
                  await page.getByTestId("fixture-log").textContent(),
                  /persist #/,
                );
              } else {
                const models = new Map(after.models.map((model) => [model.id, model]));
                assert.equal(models.get("invalid-model").enabled, false);
                assert.equal(models.get("uncertain-model").enabled, true);
                assert.equal(models.get("disabled-a").enabled, true);
                assert.ok(models.has("remote-a"));
                assert.equal(models.has("bad-model"), false);
                assert.equal(models.has("throws-model"), false);
                assert.equal(models.get("local-only").contextWindow, 65_536);
              }
              await page.keyboard.press("Escape");
              await dialog.waitFor({ state: "detached" });
              await page.getByRole("button", { name: "Reload configuration", exact: true }).click();
              await page.waitForFunction(() =>
                document
                  .querySelector('[data-testid="fixture-log"]')
                  ?.textContent.includes("reload"),
              );
              assert.deepEqual(JSON.parse(await configuration.textContent()), after);
              assert.deepEqual(errors, []);
            } finally {
              await page.close();
            }
          },
        );
      }
    }
  },
);
