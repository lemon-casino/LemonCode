import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

for (const [width, locale, theme] of [
  [1280, "zh-CN", "dark"],
  [390, "en-US", "light"],
]) {
  test(
    `routing settings save all five strategies and restore legacy (${width}, ${locale})`,
    { timeout: 90_000 },
    async (t) => {
      const { browser, port } = await startWorkflowProgressBrowser(t);
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(10_000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(
        `http://127.0.0.1:${port}/test/fixtures/provider-routing.html?locale=${locale}&theme=${theme}`,
      );
      const editor = page.getByTestId("provider-routing-editor");
      await editor.waitFor();
      await editor.getByTestId("routing-strategy").click();
      await page.getByTestId("routing-option-primary-backup").click();
      const originalCache = await editor.getByRole("combobox").nth(1).textContent();
      await editor.getByRole("spinbutton").fill("7");
      await editor.getByRole("combobox").nth(1).click();
      await page.getByRole("option").last().click();
      await page.evaluate(() => window.__routingFixture.bumpRevision());
      await editor.getByTestId("routing-save").click();
      await editor
        .getByRole("alert")
        .waitFor()
        .catch(async (error) => {
          throw new Error(
            `${error.message}; fixture=${JSON.stringify(await page.evaluate(() => window.__routingFixture))}`,
          );
        });
      assert.equal(await page.evaluate(() => window.__routingFixture.saves), 0);
      await editor.getByRole("alert").getByRole("button").click();
      await editor.getByTestId("routing-strategy").click();
      await page.getByTestId("routing-option-primary-backup").click();
      assert.equal(await editor.getByRole("spinbutton").inputValue(), "2");
      assert.equal(await editor.getByRole("combobox").nth(1).textContent(), originalCache);
      for (const strategy of [
        "reliable-first",
        "primary-backup",
        "primary-backup",
        "share-rotation",
        "headroom-balance",
        "expiry-first",
      ]) {
        const saves = await page.evaluate(() => window.__routingFixture.saves);
        await editor.getByTestId("routing-strategy").click();
        await page.getByTestId(`routing-option-${strategy}`).click();
        await editor.getByTestId("routing-save").click();
        await page.waitForFunction(
          ({ strategy, saves }) =>
            window.__routingFixture.policy?.strategy === strategy &&
            window.__routingFixture.saves > saves,
          { strategy, saves },
        );
      }
      await mkdir(".tmp/provider-routing-ui", { recursive: true });
      await page.screenshot({
        path: `.tmp/provider-routing-ui/${width}-${locale}.png`,
        fullPage: true,
      });
      await editor.getByTestId("routing-strategy").click();
      await page.getByTestId("routing-option-legacy").click();
      await editor.getByTestId("routing-save").click();
      await page.waitForFunction(() => window.__routingFixture.policy === null);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      assert.deepEqual(errors, []);
    },
  );
}
