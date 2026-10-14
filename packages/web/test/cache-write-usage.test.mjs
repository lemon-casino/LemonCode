import assert from "node:assert/strict";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "desktop and mobile OAuth summaries omit cache write without changing other token metrics",
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
      for (const scenario of ["positive", "zero", "unknown", "partial", "legacy"]) {
        await page.goto(
          `http://127.0.0.1:${port}/test/fixtures/usage-analytics.html?cache-write-case=${scenario}&locale=${locale}`,
        );
        await page.getByRole("tab", { name: mobile ? "Statistics" : "统计", exact: true }).click();
        const summary = page.getByTestId("oauth-usage-summary");
        await summary.waitFor();
        assert.equal(
          await summary.getByText(mobile ? "Cache write" : "缓存写入", { exact: true }).count(),
          0,
        );
        assert.doesNotMatch(await summary.innerText(), /至少|At least/);
        assert.equal(await summary.locator("dt").count(), 13);
        for (const [name, expected] of mobile
          ? [
              ["Cache read", "18,000"],
              ["Input tokens", "470,000"],
              ["Output tokens", "210,000"],
              ["Known tokens", "690,000"],
            ]
          : [
              ["缓存读取", "18,000"],
              ["输入 Token", "470,000"],
              ["输出 Token", "210,000"],
              ["已知 Token", "690,000"],
            ]) {
          assert.equal(
            await summary.getByText(name, { exact: true }).locator("..").locator("dd").innerText(),
            expected,
          );
        }
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
      }
      await page.close();
    }
  },
);

test(
  "session token debug omits cache write and keeps eight aligned columns including the empty state",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const mobile of [false, true]) {
      const page = await browser.newPage({
        viewport: { width: mobile ? 390 : 1280, height: 900 },
        isMobile: mobile,
        hasTouch: mobile,
      });
      const url = `http://127.0.0.1:${port}/test/fixtures/usage-analytics.html?token-debug&locale=${mobile ? "en-US" : "zh-CN"}`;
      await page.goto(url);
      const debug = page.getByTestId("developer-tools-pane");
      await debug.getByRole("cell", { name: "120", exact: true }).waitFor();
      assert.equal(await debug.getByRole("columnheader").count(), 8);
      assert.equal(await debug.getByRole("columnheader", { name: /Cache Write/i }).count(), 0);
      assert.equal(
        await debug
          .getByRole("columnheader", { name: mobile ? "Cache read" : "Cache Read", exact: true })
          .count(),
        1,
      );
      assert.deepEqual(await debug.getByRole("row").nth(1).getByRole("cell").allInnerTexts(), [
        "1",
        "100",
        "20",
        "20",
        "120",
        "5",
        "40",
        "40%",
      ]);
      assert.doesNotMatch(await debug.innerText(), /777/);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page.goto(url + "&debug-empty");
      await debug
        .getByText(mobile ? "No main session token records yet" : "暂无 main session token 记录", {
          exact: true,
        })
        .waitFor();
      assert.equal(await debug.getByRole("columnheader").count(), 8);
      assert.equal(await debug.getByRole("cell").getAttribute("colspan"), "8");
      await page.close();
    }
  },
);
