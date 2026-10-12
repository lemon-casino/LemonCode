import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "add provider opens OAuth again after leaving the API picker",
  { timeout: 90_000 },
  async (t) => {
    const { browser, port, diagnostics } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, [], diagnostics()));
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`http://127.0.0.1:${port}/test/fixtures/provider-accounts.html?navigation=1`);
      const add = page.getByTestId("model-provider-add-provider-button");
      const picker = page.getByTestId("model-provider-template-picker");
      const oauth = picker.getByRole("tab", { name: "OAuth", exact: true });
      const api = picker.getByRole("tab", { name: "API", exact: true });
      await add.click();
      await oauth.waitFor();
      assert.equal(await oauth.getAttribute("aria-selected"), "true");
      await picker.getByTestId("oauth-channel-fixture").waitFor();
      assert.equal(await page.evaluate(() => window.__providerAccounts.starts.length), 0);
      await api.click();
      assert.equal(await api.getAttribute("aria-selected"), "true");
      await picker.getByTestId("model-provider-template-item-fixture-api").click();
      assert.deepEqual(await page.evaluate(() => window.__providerAccounts.apiCreates), [
        "fixture-api",
      ]);
      await picker.getByTestId("model-provider-template-back-button").click();
      await picker.waitFor({ state: "detached" });
      await add.click();
      await oauth.waitFor();
      assert.equal(await oauth.getAttribute("aria-selected"), "true");
      await picker.getByTestId("oauth-channel-fixture").waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
    }
  },
);

test(
  "account-source provider navigation exposes its account pool without a personal overlay",
  { timeout: 90_000 },
  async (t) => {
    const { browser, port, diagnostics } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (entry) => {
      if (entry.type() === "error") errors.push(entry.text());
    });
    t.after(() => assert.deepEqual(errors, [], diagnostics()));
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/provider-accounts.html?navigation=1`);
    const provider = page.getByRole("button", { name: "Fixture OAuth pool", exact: true });
    await provider.click();
    await page.getByTestId("oauth-provider-details").waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
    await page.getByRole("tab", { name: "已登录账号", exact: true }).click();
    await page.getByTestId("oauth-account-account-2").waitFor();
    assert.equal(await page.locator("[data-oauth-account]").count(), 2);
    assert.equal(await page.getByTestId("fixture-has-personal-config").textContent(), "false");
    for (const id of ["account-1", "account-2"]) {
      await page.getByTestId(`oauth-account-${id}`).getByRole("switch").click();
    }
    await page.waitForFunction(() =>
      window.__providerAccounts.accounts.every((account) => !account.enabled),
    );
    assert.equal(await page.locator("[data-oauth-account]").count(), 2);
    await page
      .getByTestId("oauth-account-account-1")
      .getByRole("button", { name: "删除账号", exact: true })
      .click();
    await page.getByTestId("oauth-account-account-1").waitFor({ state: "detached" });
    await provider.click();
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(await page.locator("[data-oauth-account]").count(), 1);
    const details = page.getByTestId("oauth-provider-details");
    for (const number of [3, 4]) {
      await details.getByRole("tab", { name: "登录授权", exact: true }).click();
      await details.getByRole("button", { name: "开始授权", exact: true }).click();
      await details.getByLabel("授权码", { exact: true }).fill(`fixture-extra-${number}`);
      await details.getByRole("button", { name: "完成授权", exact: true }).click();
      await details.getByRole("tab", { name: "已登录账号", exact: true }).click();
      await details.getByTestId(`oauth-account-account-${number}`).waitFor();
    }
    assert.equal(await details.locator("[data-oauth-account]").count(), 3);
    assert.equal(await page.getByRole("dialog").count(), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await details.evaluate((element) => element.scrollWidth <= element.clientWidth),
      true,
    );
    await mkdir(".tmp/provider-accounts", { recursive: true });
    await page.screenshot({ path: ".tmp/provider-accounts/accounts-details-mobile.png" });
  },
);
