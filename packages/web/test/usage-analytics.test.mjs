import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

// Radix Select 迁移后的交互契约：trigger 是 button[role=combobox]，选项挂在 portal 的
// [data-slot="select-content"] 内、打开后才出现在文档里；Radix 的挂载回焦发生在内容
// 可见之后，必须先等焦点再交互（同 component-overlay-cases 的既有先例）。
async function openUsageSelect(page, name) {
  const trigger = page.getByRole("combobox", { name, exact: true });
  await trigger.click();
  const content = page.locator('[data-slot="select-content"]');
  await content.waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "option");
  return { trigger, content };
}

// 点选选项后等 portal 卸载，避免上一次的退出动画残留节点干扰下一次 role=option 查询。
async function chooseUsageSelectOption(page, name, optionName) {
  const { trigger, content } = await openUsageSelect(page, name);
  await page.getByRole("option", { name: optionName, exact: true }).click();
  await content.waitFor({ state: "detached" });
  return trigger;
}

test(
  "OAuth usage filters every view, preserves unknown usage and paginates",
  { timeout: 120_000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (entry) => {
      if (entry.type() === "error") errors.push(entry.text());
    });
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/usage-analytics.html`);
    await page.getByTestId("oauth-usage-summary").waitFor();
    const codexTrigger = await chooseUsageSelectOption(page, "供应商", "Codex");
    assert.equal((await codexTrigger.innerText()).trim(), "Codex");
    await chooseUsageSelectOption(page, "账号", "Shared account");
    await chooseUsageSelectOption(page, "模型", "shared-model");
    await page.waitForFunction(
      () => window.__analytics.last?.connectionId === "11111111-1111-4111-8111-111111111111",
    );
    assert.match(await page.getByTestId("oauth-usage-summary").innerText(), /120/);
    assert.match(await page.getByTestId("oauth-usage-summary").innerText(), /27.*1/);
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await page.waitForFunction(() => window.__analytics.last?.offset === 25);
    const claudeTrigger = await chooseUsageSelectOption(page, "供应商", "Claude");
    assert.equal((await claudeTrigger.innerText()).trim(), "Claude");
    await page.waitForFunction(
      () =>
        window.__analytics.last?.providerId === "oauth:claude" &&
        window.__analytics.last?.offset === 0 &&
        !window.__analytics.last?.connectionId,
    );
    // 原生 select 的 inputValue() 断言随迁移失效；改断言 combobox trigger 的选中项文本。
    assert.equal(
      (await page.getByRole("combobox", { name: "账号", exact: true }).innerText()).trim(),
      "全部账号",
    );
    await chooseUsageSelectOption(page, "供应商", "Codex");
    await chooseUsageSelectOption(page, "账号", "账号未记录");
    await page.waitForFunction(() => window.__analytics.last?.connectionId === null);
    await chooseUsageSelectOption(page, "账号", "已移除账号 · 33333333");
    assert.match(
      await page.getByRole("combobox", { name: "账号", exact: true }).innerText(),
      /已移除账号/,
    );
    // 时间范围走键盘路径：打开后 Radix 把焦点放在当前选中项“近 7 天”，
    // 方向键移动高亮、Enter 提交，等价原生 selectOption("24h") 的 value 语义。
    const { content: rangeContent } = await openUsageSelect(page, "时间范围");
    await page.waitForFunction(() => document.activeElement?.textContent === "近 7 天");
    await page.keyboard.press("ArrowUp");
    await page.waitForFunction(() => document.activeElement?.textContent === "近 24 小时");
    await page.keyboard.press("Enter");
    await rangeContent.waitFor({ state: "detached" });
    await page.waitForFunction(() => window.__analytics.last?.range === "24h");
    for (let index = 0; index < 3; index++) {
      await page.getByRole("button", { name: "API 用量", exact: true }).click();
      await page.getByTestId("api-usage-panel").waitFor();
      await page.getByTestId("oauth-usage-panel").waitFor({ state: "detached" });
      await page.getByRole("button", { name: "OAuth 用量", exact: true }).click();
      await page.getByTestId("oauth-usage-summary").waitFor();
    }
    const apiCalls = await page.evaluate(() => window.__analytics.apiCalls);
    assert.equal(apiCalls.length, 6);
    assert.ok(apiCalls.every((request) => request.connectionType === "api-key"));
    assert.deepEqual(new Set(apiCalls.map((request) => request.range)), new Set(["all", "7d"]));
    await mkdir(".tmp/usage-analytics", { recursive: true });
    await page
      .getByRole("heading", { name: "OAuth 用量概览", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: ".tmp/usage-analytics/desktop-dark.png" });
    await page.getByRole("heading", { name: "当前账号额度", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: ".tmp/usage-analytics/desktop-quota-dark.png" });
    assert.deepEqual(errors, []);
  },
);

test(
  "API and OAuth tabs stay selectable on mobile and migrate a removed plan intent",
  { timeout: 120_000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    await page.goto(
      `http://127.0.0.1:${port}/test/fixtures/usage-analytics.html?locale=en-US&theme=light&legacy-intent`,
    );
    const tabs = page.getByLabel("Connection type", { exact: true });
    assert.equal(await tabs.getByRole("button").count(), 2);
    await page.getByTestId("oauth-usage-summary").waitFor();
    assert.equal(
      await page.evaluate(() => sessionStorage.getItem("lcode-settings-usage-tab-intent")),
      null,
    );
    for (let index = 0; index < 3; index++) {
      await tabs.getByRole("button", { name: "API usage", exact: true }).click();
      await page.getByTestId("api-usage-panel").waitFor();
      await tabs.getByRole("button", { name: "OAuth usage", exact: true }).click();
      await page.getByTestId("oauth-usage-summary").waitFor();
    }
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
  },
);

test(
  "statistics failure leaves upstream quota usable and late responses cannot cross filters",
  { timeout: 120_000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(
      `http://127.0.0.1:${port}/test/fixtures/usage-analytics.html?scenario=unavailable`,
    );
    await page.getByText("调用统计暂不可用，请先打开工作区后重试。").waitFor();
    await page
      .getByTestId("quota-11111111-1111-4111-8111-111111111111")
      .getByRole("heading", { name: "Codex · Shared account", exact: true })
      .waitFor();
    await page
      .getByTestId("quota-22222222-2222-4222-8222-222222222222")
      .getByRole("heading", { name: "Claude · Shared account", exact: true })
      .waitFor();
    await page.getByTestId("quota-11111111-1111-4111-8111-111111111111").getByText("75%").waitFor();
    await page
      .getByTestId("quota-11111111-1111-4111-8111-111111111111")
      .getByRole("button", { name: "刷新额度" })
      .click();
    await page.getByText("正在显示上次成功读取的数据").waitFor();
    await page.getByTestId("quota-11111111-1111-4111-8111-111111111111").getByText("75%").waitFor();
    await page
      .getByTestId("quota-22222222-2222-4222-8222-222222222222")
      .getByText("此供应商暂不提供额度")
      .waitFor();
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await page.waitForFunction(
      () => window.__analytics.quotaCalls.filter((call) => call.force).length === 3,
    );
    await page.getByTestId("refresh-visible-quotas").click();
    await page.waitForFunction(
      () => window.__analytics.quotaCalls.filter((call) => call.force).length === 5,
    );
    await page.goto(
      `http://127.0.0.1:${port}/test/fixtures/usage-analytics.html?scenario=deferred`,
    );
    await chooseUsageSelectOption(page, "供应商", "Codex");
    await page.waitForFunction(() => window.__analytics.pending);
    await chooseUsageSelectOption(page, "供应商", "Claude");
    await page.getByTestId("oauth-usage-summary").getByText("240", { exact: true }).waitFor();
    await page.evaluate(() => window.__analytics.release());
    assert.match(await page.getByTestId("oauth-usage-summary").innerText(), /240/);
  },
);

test(
  "quota bulk refresh works during statistics loading and stays within the visible account scope",
  { timeout: 120_000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(
      `http://127.0.0.1:${port}/test/fixtures/usage-analytics.html?scenario=quota-refresh`,
    );
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    await page.getByTestId(`quota-${first}`).getByText("75%").waitFor();
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await page.waitForFunction(
      () => window.__analytics.quotaCalls.filter((call) => call.force).length === 2,
    );
    assert.deepEqual(
      await page.evaluate(() =>
        window.__analytics.quotaCalls
          .filter((call) => call.force)
          .map((call) => call.id)
          .sort(),
      ),
      [first, second],
    );
    await chooseUsageSelectOption(page, "供应商", "Codex");
    await page.getByTestId("refresh-visible-quotas").click();
    await page.waitForFunction(
      () => window.__analytics.quotaCalls.filter((call) => call.force).length === 3,
    );
    assert.equal(await page.evaluate(() => window.__analytics.quotaCalls.at(-1).id), first);
    const readsBeforeRevision = await page.evaluate(() => window.__analytics.quotaCalls.length);
    await page.evaluate(() => window.__analytics.touchAccounts());
    await page.waitForFunction(
      (count) => window.__analytics.quotaCalls.length > count,
      readsBeforeRevision,
    );
    assert.equal(await page.evaluate(() => window.__analytics.quotaCalls.at(-1).force), false);
    await page.evaluate(() => {
      window.__analytics.holdNextQuota = true;
    });
    await page.getByTestId("refresh-visible-quotas").click();
    await page.waitForFunction(() => window.__analytics.quotaPending);
    await chooseUsageSelectOption(page, "供应商", "Claude");
    await page.getByTestId(`quota-${second}`).getByText("此供应商暂不提供额度").waitFor();
    assert.equal(await page.evaluate(() => window.__analytics.quotaCalls.at(-1).force), false);
    await page.evaluate(() => window.__analytics.releaseQuota());
    assert.equal(await page.getByTestId(`quota-${first}`).count(), 0);
    assert.doesNotMatch(await page.getByTestId(`quota-${second}`).innerText(), /75%/);
  },
);

test(
  "quota cards preserve monetary and partial facts, recover on retry and fit mobile",
  { timeout: 120_000 },
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
      `http://127.0.0.1:${port}/test/fixtures/usage-analytics.html?scenario=quota-rich&locale=en-US&theme=light`,
    );
    const card = page.getByTestId("quota-11111111-1111-4111-8111-111111111111");
    await card
      .getByText("Some quota data is unavailable; showing the available readings.")
      .waitFor();
    await card.getByText("$30.00 remaining of $40.00", { exact: true }).waitFor();
    assert.match(await card.innerText(), /75%/);
    assert.match(await card.innerText(), /25%/);
    assert.match(await card.innerText(), /Used\s+10 USD/);
    assert.match(await card.innerText(), /Remaining\s+30 USD/);
    assert.match(await card.innerText(), /Limit\s+40 USD/);
    assert.match(await card.innerText(), /Remaining\s+0 tokens/);
    assert.match(await card.innerText(), /Used\s+0 requests/);
    assert.match(await card.innerText(), /Balance.*\$12.50 USD/);
    assert.match(await card.innerText(), /Auto-renewal.*On/);
    assert.match(await card.innerText(), /Plan expires/);
    assert.match(await card.innerText(), /Expires/);
    assert.match(await card.innerText(), /Pool.*shared-pool/);
    assert.match(await card.innerText(), /Model.*long-model-name-for-mobile-window-readability/);
    assert.equal(await card.locator('[data-slot="progress"]').count(), 1);
    const unknown = page.getByTestId("quota-22222222-2222-4222-8222-222222222222");
    await unknown.getByText("Team plan", { exact: true }).waitFor();
    assert.match(await unknown.innerText(), /Auto-renewal.*Off/);
    assert.match(await unknown.innerText(), /Plan expires/);
    assert.equal(await unknown.locator('[data-slot="progress"]').count(), 0);
    await card.scrollIntoViewIfNeeded();
    const overflowing = await card.evaluate((element) =>
      [...element.querySelectorAll("div, p, dl, dd")]
        .filter((child) => child.scrollWidth > child.clientWidth + 1)
        .map((child) => child.textContent),
    );
    assert.deepEqual(overflowing, []);
    await mkdir(".tmp/usage-analytics", { recursive: true });
    await page.screenshot({ path: ".tmp/usage-analytics/quota-mobile-light.png" });
    await card.getByRole("button", { name: "Refresh quota", exact: true }).click();
    await card.getByText("Showing the last successful reading").waitFor();
    await card.getByText("$30.00 remaining of $40.00", { exact: true }).waitFor();
    await card.getByRole("button", { name: "Refresh quota", exact: true }).click();
    await card
      .getByText("Some quota data is unavailable; showing the available readings.")
      .waitFor({ state: "detached" });
    assert.doesNotMatch(await card.innerText(), /Showing the last successful reading/);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.deepEqual(errors, []);
  },
);

test(
  "context history opens for main and child sessions, follows snapshots and stays mobile accessible",
  { timeout: 120_000 },
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
    await page
      .getByTestId("main-context")
      .getByRole("button", { name: /Context/ })
      .click();
    await page
      .locator('[data-slot="hover-card-content"]')
      .getByRole("button", { name: "Context trend", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("Earlier samples are omitted.").waitFor();
    assert.match(await dialog.innerText(), /Compaction/);
    assert.match(await dialog.innerText(), /Unknown/);
    await mkdir(".tmp/usage-analytics", { recursive: true });
    await dialog.locator("svg.recharts-surface").waitFor();
    assert.equal(await dialog.locator(".recharts-line-dots circle").count(), 2);
    await dialog.getByText("Window capacity", { exact: true }).first().waitFor();
    const bounds = await dialog.evaluate((element) => {
      const outer = element.getBoundingClientRect();
      return [
        ...element.querySelectorAll(
          '[data-slot="dialog-description"], [data-slot="chart"], svg.recharts-surface',
        ),
      ].map((child) => {
        const box = child.getBoundingClientRect();
        return {
          slot: child.getAttribute("data-slot") ?? child.tagName,
          left: box.left - outer.left,
          right: outer.right - box.right,
          overflow: child.scrollWidth - child.clientWidth,
        };
      });
    });
    for (const bound of bounds) {
      assert.ok(bound.left >= 0 && bound.right >= 0 && bound.overflow <= 1, JSON.stringify(bound));
    }
    await dialog.screenshot({ path: ".tmp/usage-analytics/context-mobile-light.png" });
    await page.evaluate(() => window.__analytics.switchSession());
    await dialog.getByText("new-model", { exact: true }).waitFor();
    assert.doesNotMatch(await dialog.innerText(), /old-model/);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert.equal(
      await page
        .getByTestId("main-context")
        .getByRole("button", { name: /Context/ })
        .evaluate((element) => element === document.activeElement),
      true,
    );
    await page
      .getByTestId("read-only-session-token-stats")
      .getByRole("button", { name: "Context trend", exact: true })
      .click();
    await dialog.getByText("child-model", { exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.deepEqual(errors, []);
  },
);
