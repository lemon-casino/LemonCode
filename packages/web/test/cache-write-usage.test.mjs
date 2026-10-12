import assert from "node:assert/strict";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "desktop and mobile OAuth cache write summaries distinguish unknown, zero and partial coverage",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const mobile of [false, true]) {
      const locale = mobile ? "en-US" : "zh-CN";
      const page = await browser.newPage({
        viewport: { width: mobile ? 390 : 1280, height: 900 },
        isMobile: mobile,
        hasTouch: mobile,
      });
      for (const [scenario, expected] of [
        ["positive", "30"],
        ["zero", "0"],
        ["unknown", mobile ? "Unknown" : "未知"],
        ["partial", mobile ? "At least 30" : "至少 30"],
        ["legacy", mobile ? "Unknown" : "未知"],
      ]) {
        await page.goto(
          `http://127.0.0.1:${port}/test/fixtures/usage-analytics.html?cache-write-case=${scenario}&locale=${locale}`,
        );
        const summary = page.getByTestId("oauth-usage-summary");
        await summary.waitFor();
        const value = summary
          .getByText(mobile ? "Cache write" : "缓存写入", { exact: true })
          .locator("..")
          .locator("dd");
        assert.equal(await value.innerText(), expected);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
      }
      await page.close();
    }
  },
);
