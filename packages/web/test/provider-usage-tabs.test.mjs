import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "OAuth views default to 24 hours and preserve filters, pagination and quota reads",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/usage-analytics.html`);
    await page.getByTestId("oauth-usage-panel").waitFor();
    const tabs = page.getByRole("tablist", { name: "OAuth 用量视图", exact: true });
    assert.equal(await tabs.getByRole("tab").count(), 3);
    assert.equal(
      await tabs.getByRole("tab", { name: "图表", exact: true }).getAttribute("aria-selected"),
      "true",
    );
    await page.waitForFunction(() => window.__analytics.last?.range === "24h");
    assert.equal(
      (await page.getByRole("combobox", { name: "时间范围", exact: true }).innerText()).trim(),
      "近 24 小时",
    );
    await page.getByTestId("oauth-token-activity").waitFor();
    assert.equal(await page.getByTestId("oauth-usage-summary").isVisible(), false);
    await page.getByRole("combobox", { name: "供应商", exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "option");
    await page.getByRole("option", { name: "Codex", exact: true }).click();
    await page.locator('[data-slot="select-content"]').waitFor({ state: "detached" });
    await page.waitForFunction(() => window.__analytics.last?.providerId === "oauth:codex");
    const charts = tabs.getByRole("tab", { name: "图表", exact: true });
    await charts.focus();
    await page.keyboard.press("ArrowRight");
    await page.getByTestId("oauth-usage-summary").waitFor();
    assert.equal(
      await tabs.getByRole("tab", { name: "统计", exact: true }).getAttribute("aria-selected"),
      "true",
    );
    assert.equal(await page.getByTestId("oauth-token-activity").isVisible(), false);
    const lifetime = await page.getByTestId("oauth-lifetime-summary").innerText();
    const lifetimeReads = await page.evaluate(() => window.__analytics.lifetimeCalls.length);
    await page.getByRole("combobox", { name: "时间范围", exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "option");
    await page.getByRole("option", { name: "近 7 天", exact: true }).click();
    await page.locator('[data-slot="select-content"]').waitFor({ state: "detached" });
    await page.waitForFunction(() => window.__analytics.last?.range === "7d");
    await tabs.getByRole("tab", { name: "请求与额度", exact: true }).click();
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await page.waitForFunction(() => window.__analytics.last?.offset === 25);
    await page.getByRole("button", { name: "上一页", exact: true }).waitFor();
    await page.getByTestId("quota-11111111-1111-4111-8111-111111111111").getByText("75%").waitFor();
    const before = await page.evaluate(() => ({
      range: window.__analytics.rangeCalls.length,
      quota: window.__analytics.quotaCalls.length,
    }));
    await tabs.getByRole("tab", { name: "统计", exact: true }).click();
    assert.match(await page.getByTestId("oauth-usage-summary").innerText(), /120/);
    assert.equal(await page.getByTestId("oauth-lifetime-summary").innerText(), lifetime);
    assert.equal(await page.evaluate(() => window.__analytics.lifetimeCalls.length), lifetimeReads);
    await charts.click();
    await page.getByTestId("oauth-token-activity").waitFor();
    await tabs.getByRole("tab", { name: "请求与额度", exact: true }).click();
    assert.match(await page.getByRole("tabpanel").innerText(), /26–40 \/ 40 次请求/);
    assert.equal(
      (await page.getByRole("combobox", { name: "供应商", exact: true }).innerText()).trim(),
      "Codex",
    );
    assert.equal(
      (await page.getByRole("combobox", { name: "时间范围", exact: true }).innerText()).trim(),
      "近 7 天",
    );
    assert.deepEqual(
      await page.evaluate(() => ({
        range: window.__analytics.rangeCalls.length,
        quota: window.__analytics.quotaCalls.length,
      })),
      before,
    );
    assert.deepEqual(errors, []);
  },
);

test(
  "OAuth statistics display every column with long account names on desktop and mobile",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    await mkdir(".tmp/usage-analytics", { recursive: true });
    for (const mobile of [false, true]) {
      const page = await browser.newPage({
        viewport: { width: mobile ? 390 : 1280, height: 900 },
        isMobile: mobile,
        hasTouch: mobile,
      });
      await page.goto(
        `http://127.0.0.1:${port}/test/fixtures/usage-analytics.html?scenario=long-labels&locale=${mobile ? "en-US" : "zh-CN"}&theme=${mobile ? "dark" : "light"}`,
      );
      await page.getByTestId("oauth-usage-panel").waitFor();
      await page.evaluate(() =>
        document.documentElement.style.setProperty("--ui-font-size", "20px"),
      );
      const tabs = page.getByRole("tablist", {
        name: mobile ? "OAuth usage views" : "OAuth 用量视图",
        exact: true,
      });
      assert.equal(await tabs.getByRole("tab").count(), 3);
      await tabs.getByRole("tab", { name: mobile ? "Statistics" : "统计", exact: true }).click();
      await page.getByTestId("oauth-usage-summary").waitFor();
      for (const name of mobile
        ? ["By provider", "By account", "By model"]
        : ["供应商统计", "账号统计", "模型统计"]) {
        const group = page.getByRole("region", { name, exact: true });
        const layout = await group.evaluate((element) => {
          const scroll = element.querySelector("table").parentElement;
          return {
            width: scroll.clientWidth,
            overflow: scroll.scrollWidth - scroll.clientWidth,
            columns: element.querySelectorAll("thead th").length,
          };
        });
        assert.equal(layout.columns, 4);
        if (!mobile) assert.ok(layout.overflow <= 1, JSON.stringify({ name, ...layout }));
        // 手机大字号允许表内滚动；滚到最右列后须完整可见，页面本身不横向滚动。
        const lastColumnFits = await group.evaluate((element) => {
          const table = element.querySelector("table");
          const scroll = table.parentElement;
          scroll.scrollLeft = scroll.scrollWidth;
          return (
            table.querySelector("thead th:last-child").getBoundingClientRect().right <=
            scroll.getBoundingClientRect().right + 1
          );
        });
        assert.equal(lastColumnFits, true);
        await group.locator("table").evaluate((table) => {
          table.parentElement.scrollLeft = 0;
        });
      }
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page
        .getByRole("region", { name: mobile ? "By account" : "账号统计", exact: true })
        .scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `.tmp/usage-analytics/statistics-${mobile ? "mobile-dark" : "desktop-light"}.png`,
      });
      await tabs.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `.tmp/usage-analytics/tabs-${mobile ? "mobile-dark" : "desktop-light"}.png`,
      });
      await tabs
        .getByRole("tab", { name: mobile ? "Requests & quotas" : "请求与额度", exact: true })
        .click();
      const requests = page.getByRole("region", {
        name: mobile ? "Recent requests" : "最近请求",
        exact: true,
      });
      await requests
        .getByRole("columnheader", { name: mobile ? "Request duration" : "请求耗时", exact: true })
        .waitFor();
      assert.equal(await requests.getByRole("columnheader").count(), 7);
      await requests.locator("table").evaluate((table) => {
        table.parentElement.scrollLeft = table.parentElement.scrollWidth;
      });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page.close();
    }
  },
);

test(
  "mobile charts retain activity details and model graphs in the charts view",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(
      `http://127.0.0.1:${port}/test/fixtures/usage-analytics.html?locale=en-US&theme=light`,
    );
    const activity = page.getByTestId("oauth-token-activity");
    await activity.getByRole("tab", { name: "Weekly", exact: true }).click();
    await page.getByTestId("oauth-activity-weekly").waitFor();
    await activity.locator("summary").focus();
    await page.keyboard.press("Enter");
    await activity.getByRole("table").waitFor();
    await page.getByTestId("oauth-model-usage").locator("svg.recharts-surface").first().waitFor();
    assert.match(await page.getByTestId("oauth-model-usage").innerText(), /Codex · shared-model/);
    assert.match(await page.getByTestId("oauth-model-usage").innerText(), /Claude · shared-model/);
    assert.equal(
      await page
        .getByRole("region", { name: "Daily known token usage", exact: true })
        .locator("svg.recharts-surface")
        .count(),
      1,
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await mkdir(".tmp/usage-analytics", { recursive: true });
    await page
      .getByRole("tablist", { name: "OAuth usage views", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: ".tmp/usage-analytics/charts-mobile-light.png" });
    assert.deepEqual(errors, []);
  },
);
