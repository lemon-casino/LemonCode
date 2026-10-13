import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "OAuth tabs stay compact with readable labels across locales, viewports and UI sizes",
  { timeout: 90_000 },
  async (t) => {
    const { browser, port, diagnostics } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, [], diagnostics()));
    for (const locale of ["zh-CN", "en-US"]) {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.goto(
        `http://127.0.0.1:${port}/test/fixtures/provider-accounts.html?navigation=1&scroll=1&locale=${locale}&theme=${locale === "en-US" ? "light" : "dark"}`,
      );
      await page.getByRole("button", { name: "Fixture OAuth pool", exact: true }).click();
      const oauth = page.getByTestId("oauth-provider-details");
      const tabList = oauth.getByRole("tablist");
      const tabs = tabList.getByRole("tab");
      assert.equal(await tabs.count(), 3);
      for (const viewport of [
        { width: 1920, height: 1080 },
        { width: 390, height: 844 },
        { width: 320, height: 568 },
      ]) {
        await page.setViewportSize(viewport);
        for (const size of ["14px", "20px"]) {
          await page.evaluate(
            (fontSize) => document.documentElement.style.setProperty("--ui-font-size", fontSize),
            size,
          );
          const bounds = await tabList.boundingBox();
          assert.ok(bounds && bounds.width <= 384.5, "tab bar must not stretch across the panel");
          for (let index = 0; index < 3; index++) {
            const tab = tabs.nth(index);
            const box = await tab.boundingBox();
            assert.ok(box && box.width <= 128.5, "individual tabs remain compact");
            assert.ok(await tab.evaluate((element) => element.scrollWidth <= element.clientWidth));
            await tab.click();
            assert.equal(await tab.getAttribute("aria-selected"), "true");
          }
          const overflow = await oauth.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return [...element.querySelectorAll("*")]
              .filter((node) => node.getBoundingClientRect().right > bounds.right + 1)
              .slice(0, 8)
              .map((node) => ({ tag: node.tagName, text: node.textContent?.slice(0, 80) }));
          });
          assert.ok(
            await oauth.evaluate((element) => element.scrollWidth <= element.clientWidth),
            JSON.stringify({ locale, viewport, size, overflow }),
          );
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        }
      }
    }
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.evaluate(() => document.documentElement.style.removeProperty("--ui-font-size"));
    await page.goto(
      `http://127.0.0.1:${port}/test/fixtures/provider-accounts.html?navigation=1&scroll=1`,
    );
    await page.getByRole("button", { name: "Fixture OAuth pool", exact: true }).click();
    await mkdir(".tmp/provider-proxy", { recursive: true });
    await page
      .getByTestId("oauth-provider-details")
      .getByRole("tablist")
      .screenshot({ path: ".tmp/provider-proxy/oauth-compact-tabs.png" });
  },
);

test(
  "model settings retain independent API/OAuth provider proxy choices",
  { timeout: 90_000 },
  async (t) => {
    const { browser, port, diagnostics } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, [], diagnostics()));
    await page.goto(
      `http://127.0.0.1:${port}/test/fixtures/provider-accounts.html?navigation=1&scroll=1`,
    );
    await page.getByRole("button", { name: "Fixture API 1", exact: true }).click();
    const api = page.locator('[data-provider-proxy="scroll-api-1"]');
    await api.getByRole("combobox").click();
    await page.getByRole("option", { name: "使用专用代理", exact: true }).click();
    await api.getByLabel("HTTP 代理", { exact: true }).fill("socks4://localhost:7890");
    assert.equal(await api.getByRole("button", { name: "保存", exact: true }).isEnabled(), false);
    await api.getByLabel("HTTP 代理", { exact: true }).fill("http://127.0.0.1:7891");
    await api
      .getByLabel("HTTP 代理", { exact: true })
      .fill("http://fixture%40user:fixture%3Ap%40ss%25@127.0.0.1:7891");
    assert.equal(
      await api.getByLabel("HTTP 代理", { exact: true }).inputValue(),
      "http://127.0.0.1:7891",
    );
    assert.equal(
      await api.getByLabel("代理用户名（可选）", { exact: true }).inputValue(),
      "fixture@user",
    );
    assert.equal(
      await api.getByLabel("代理密码（可选）", { exact: true }).inputValue(),
      "fixture:p@ss%",
    );
    await api.getByLabel("不使用代理的地址", { exact: true }).fill(".fixture.invalid");
    await api.getByLabel("代理用户名（可选）", { exact: true }).fill("fixture@user");
    await api.getByLabel("代理密码（可选）", { exact: true }).fill("fixture:p@ss%");
    assert.equal(
      await api.getByLabel("代理密码（可选）", { exact: true }).getAttribute("type"),
      "password",
    );
    await api.getByRole("button", { name: "保存", exact: true }).click();
    await page.waitForFunction(
      () =>
        window.__providerAccounts.proxyNetworks["scroll-api-1"]?.httpProxy ===
        "http://fixture%40user:fixture%3Ap%40ss%25@127.0.0.1:7891",
    );
    await page.getByRole("button", { name: "Fixture API 2", exact: true }).click();
    assert.match(
      await page.locator('[data-provider-proxy="scroll-api-2"]').innerText(),
      /不使用代理/,
    );
    await page.getByRole("button", { name: "Fixture OAuth pool", exact: true }).click();
    const oauth = page.getByTestId("oauth-provider-details");
    assert.deepEqual(await oauth.getByRole("tab").allTextContents(), [
      "登录授权",
      "模型配置",
      "已登录账号",
    ]);
    const route = oauth.locator("[data-provider-proxy]");
    assert.match(await route.getByRole("combobox").innerText(), /不使用代理/);
    await route.getByRole("combobox").click();
    await page.getByRole("option", { name: "使用默认代理", exact: true }).click();
    await route.getByRole("button", { name: "保存", exact: true }).click();
    await page.waitForFunction(
      () =>
        window.__providerAccounts.proxyNetworks["oauth_fixture_openai-responses"]?.mode ===
        "default",
    );
    await route.getByRole("combobox").click();
    await page.getByRole("option", { name: "不使用代理", exact: true }).click();
    await route.getByRole("button", { name: "保存", exact: true }).click();
    await page.waitForFunction(
      () =>
        window.__providerAccounts.proxyNetworks["oauth_fixture_openai-responses"]?.mode ===
        "direct",
    );
    await oauth.getByRole("button", { name: "开始授权", exact: true }).click();
    await oauth.getByLabel("授权码", { exact: true }).fill("retained-draft");
    await oauth.getByRole("tab", { name: "已登录账号", exact: true }).click();
    assert.equal(await oauth.getByRole("button", { name: "开始授权", exact: true }).count(), 0);
    await oauth.getByTestId("oauth-account-account-1").waitFor();
    await oauth.getByRole("tab", { name: "登录授权", exact: true }).click();
    assert.equal(await oauth.getByLabel("授权码", { exact: true }).inputValue(), "retained-draft");
    await oauth.getByRole("button", { name: "取消授权", exact: true }).click();
    assert.equal(
      await page.evaluate(() => window.__providerAccounts.proxyNetworks["scroll-api-1"].httpProxy),
      "http://fixture%40user:fixture%3Ap%40ss%25@127.0.0.1:7891",
    );
    for (const viewport of [
      { width: 1920, height: 1080 },
      { width: 390, height: 844 },
      { width: 320, height: 568 },
    ]) {
      await page.setViewportSize(viewport);
      await oauth.getByRole("tab", { name: "已登录账号", exact: true }).click();
      assert.ok(await oauth.evaluate((element) => element.scrollWidth <= element.clientWidth));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await mkdir(".tmp/provider-proxy", { recursive: true });
    await page.screenshot({ path: ".tmp/provider-proxy/oauth-mobile.png" });
  },
);

test(
  "dedicated proxy settings manage global controls and the library without provider routing",
  { timeout: 90_000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(
      `http://127.0.0.1:${port}/test/fixtures/provider-accounts.html?navigation=1&scroll=1&proxy=1&theme=light`,
    );
    await page.getByTestId("proxy-library").waitFor();
    assert.equal(await page.getByLabel("HTTP 代理", { exact: true }).isVisible(), false);
    assert.equal(await page.getByRole("heading", { name: "供应商代理", exact: true }).count(), 0);
    assert.equal(await page.locator("[data-provider-proxy]").count(), 0);
    assert.equal(await page.getByRole("button", { name: "导入代理", exact: true }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "检测全部代理", exact: true }).count(), 1);
    const paste = page.getByLabel("批量粘贴代理", { exact: true });
    await paste.fill("http://draft.example:7890");
    const singleTab = page.getByRole("tab", { name: "单个 HTTP 代理", exact: true });
    const listTab = page.getByRole("tab", { name: "代理列表", exact: true });
    await singleTab.click();
    const address = page.getByLabel("HTTP 代理", { exact: true });
    await address.fill("https://draft.example:8443");
    await page.getByText("自定义证书", { exact: true }).first().waitFor();
    await listTab.click();
    assert.equal(await paste.inputValue(), "http://draft.example:7890");
    await singleTab.click();
    assert.equal(await address.inputValue(), "https://draft.example:8443");
    assert.deepEqual(await page.evaluate(() => window.__providerAccounts.proxyNetworks), {});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  },
);

test(
  "bulk proxy import, authenticated editing, assignment and connectivity feedback work together",
  { timeout: 90_000 },
  async (t) => {
    const { browser, port, diagnostics } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, [], diagnostics()));
    await page.goto(
      `http://127.0.0.1:${port}/test/fixtures/provider-accounts.html?navigation=1&scroll=1&proxy=1`,
      { timeout: 30_000 },
    );
    const library = page.getByTestId("proxy-library");
    const input = library.getByLabel("批量粘贴代理", { exact: true });
    await input.fill("http://fixture:secret@proxy.example:7890\ninvalid");
    assert.match(await library.getByRole("alert").innerText(), /第 2 行/);
    assert.equal(
      await library.getByRole("button", { name: "导入代理", exact: true }).isEnabled(),
      false,
    );
    await input.fill(
      "http://fixture:secret@proxy.example:7890\nhttps://proxy.example:8443\nsocks5://fixture:secret@proxy.example:1080\nhttp://fixture:secret@proxy.example:7890",
    );
    await library.getByRole("button", { name: "导入代理", exact: true }).click();
    await page.waitForFunction(() => window.__providerAccounts.proxyProfiles.length === 3);
    assert.equal(await library.locator("[data-proxy-profile]").count(), 3);
    assert.equal((await library.innerText()).includes("secret"), false);
    await page.getByRole("button", { name: "模型设置", exact: true }).click();
    await page.getByRole("button", { name: "Fixture API 1", exact: true }).click();
    const api = page.locator('[data-provider-proxy="scroll-api-1"]');
    await api.getByRole("combobox").click();
    await page.getByRole("option", { name: "HTTP proxy.example:7890", exact: true }).click();
    await api.getByRole("button", { name: "保存", exact: true }).click();
    await page.waitForFunction(
      () => window.__providerAccounts.proxyNetworks["scroll-api-1"]?.profileId === "proxy-1",
    );
    await page.getByRole("button", { name: "代理", exact: true }).click();
    const first = library.locator('[data-proxy-profile="proxy-1"]');
    assert.equal(await first.getByRole("button", { name: "删除", exact: true }).isEnabled(), false);
    await library.getByRole("button", { name: "检测全部代理", exact: true }).click();
    await first.getByRole("status").waitFor();
    assert.match(await first.getByRole("status").innerText(), /连接成功.*42 ms/);
    assert.match(
      await library.locator('[data-proxy-profile="proxy-3"]').getByRole("status").innerText(),
      /连接失败/,
    );
    await first.getByRole("button", { name: /HTTP proxy.example:7890/ }).click();
    assert.equal(
      await first.getByLabel("代理密码（可选）", { exact: true }).inputValue(),
      "secret",
    );
    await first.getByLabel("代理名称", { exact: true }).fill("主代理");
    await first.getByLabel("HTTP 代理", { exact: true }).fill("socks5://new-proxy.example:1081");
    await first.getByRole("button", { name: "保存", exact: true }).click();
    await page.waitForFunction(() => window.__providerAccounts.proxyProfiles[0].name === "主代理");
    await page.getByRole("button", { name: "模型设置", exact: true }).click();
    await page.getByRole("button", { name: "Fixture API 1", exact: true }).click();
    assert.match(await api.getByRole("combobox").innerText(), /主代理/);
    assert.equal(
      await page.evaluate(() => window.__providerAccounts.proxyNetworks["scroll-api-1"].profileId),
      "proxy-1",
    );
    await page.getByRole("button", { name: "代理", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await mkdir(".tmp/provider-proxy", { recursive: true });
    await page.screenshot({ path: ".tmp/provider-proxy/library-mobile.png" });
  },
);
