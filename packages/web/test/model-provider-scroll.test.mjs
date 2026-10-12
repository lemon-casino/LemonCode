import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

const navigationSelector = '[data-model-provider-navigation-scroll="true"]';
const detailSelector = '[data-model-provider-detail-scroll="true"]';

async function wheelInside(page, locator, delta) {
  const bounds = await locator.boundingBox();
  assert.ok(bounds);
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, delta);
  // 等待浏览器提交滚轮与合成滚动，不用固定延时猜测状态。
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

async function assertScrollIsolation(page, selector, otherSelector) {
  const owner = page.locator(selector);
  const outer = page.getByTestId("fixture-settings-scroll");
  await outer.evaluate((element) => {
    element.scrollTop = 0;
  });
  const otherTop = await page.locator(otherSelector).evaluate((element) => element.scrollTop);
  assert.ok(await owner.evaluate((element) => element.scrollHeight > element.clientHeight));
  for (const [edge, delta] of [
    ["top", -500],
    ["bottom", 500],
  ]) {
    await owner.evaluate((element, edge) => {
      element.scrollTop = edge === "top" ? 0 : element.scrollHeight;
    }, edge);
    await wheelInside(page, owner, delta);
    assert.equal(
      await outer.evaluate((element) => element.scrollTop),
      0,
      `${selector} ${edge} must contain wheel scrolling`,
    );
    assert.equal(
      await page.locator(otherSelector).evaluate((element) => element.scrollTop),
      otherTop,
    );
  }
  await owner.evaluate((element) => {
    element.scrollTop = 0;
  });
  await wheelInside(page, owner, 300);
  await page.waitForFunction(
    (selector) => document.querySelector(selector).scrollTop > 0,
    selector,
  );
  assert.equal(await outer.evaluate((element) => element.scrollTop), 0);
  await owner.focus();
  await page.keyboard.press("Control+Home");
  await page.waitForFunction(
    (selector) => document.querySelector(selector).scrollTop === 0,
    selector,
  );
  await page.keyboard.press("Control+End");
  await page.waitForFunction((selector) => {
    const element = document.querySelector(selector);
    return Math.abs(element.scrollTop - (element.scrollHeight - element.clientHeight)) <= 1;
  }, selector);
  assert.equal(await outer.evaluate((element) => element.scrollTop), 0);
}

test(
  "model settings keep custom navigation, OAuth and API details in independent fixed-height scroll panes",
  { timeout: 120_000 },
  async (t) => {
    const { browser, port, diagnostics } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, [], diagnostics()));
    await mkdir(".tmp/model-provider-scroll", { recursive: true });
    for (const { width, height, locale, theme } of [
      { width: 1280, height: 900, locale: "zh-CN", theme: "dark" },
      { width: 1280, height: 600, locale: "en-US", theme: "light" },
      { width: 390, height: 844, locale: "en-US", theme: "light" },
      { width: 320, height: 568, locale: "zh-CN", theme: "dark" },
    ]) {
      await page.setViewportSize({ width, height });
      await page.goto(
        `http://127.0.0.1:${port}/test/fixtures/provider-accounts.html?navigation=1&scroll=1&locale=${locale}&theme=${theme}`,
      );
      const navigation = page.locator(navigationSelector);
      const details = page.locator(detailSelector);
      await navigation.getByRole("button", { name: "Fixture API 1", exact: true }).click();
      await details.getByText("scroll-model-24", { exact: true }).waitFor({ state: "attached" });
      const paneHeight = await page
        .locator("[data-model-provider-split-panel]")
        .evaluate((element) => element.getBoundingClientRect().height);
      assert.ok(
        Math.abs(paneHeight - Math.min(576, height - 192)) <= 1,
        `fixed pane height at ${width}x${height}: ${paneHeight}`,
      );
      await details.getByRole("button", { name: "Show fixture feedback", exact: true }).click();
      const feedback = page.getByText("Fixture feedback", { exact: true });
      await feedback.waitFor();
      const feedbackTop = await feedback.evaluate((element) => element.getBoundingClientRect().top);
      await assertScrollIsolation(page, detailSelector, navigationSelector);
      assert.equal(
        await feedback.evaluate((element) => element.getBoundingClientRect().top),
        feedbackTop,
      );
      await assertScrollIsolation(page, navigationSelector, detailSelector);
      await navigation.getByRole("button", { name: "Fixture API 24", exact: true }).click();
      await navigation.getByRole("button", { name: "Fixture OAuth pool", exact: true }).click();
      await page.getByTestId("oauth-account-account-20").waitFor({ state: "attached" });
      assert.equal(
        await page
          .locator("[data-model-provider-split-panel]")
          .evaluate((element) => element.getBoundingClientRect().height),
        paneHeight,
      );
      await assertScrollIsolation(page, detailSelector, navigationSelector);
      assert.ok(await details.evaluate((element) => element.scrollWidth <= element.clientWidth));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await details.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await page.screenshot({ path: `.tmp/model-provider-scroll/oauth-${width}-${height}.png` });
    }
  },
);
