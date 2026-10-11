import "./provider-accounts-model-cases.mjs";
import "./provider-accounts-navigation-cases.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "provider picker preserves API and manages independent OAuth accounts",
  { timeout: 120_000 },
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
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/provider-accounts.html`);
    const api = page.getByRole("tab", { name: "API", exact: true });
    const oauth = page.getByRole("tab", { name: "OAuth", exact: true });
    await api.waitFor();
    assert.equal(await api.getAttribute("aria-selected"), "true");
    await page.getByTestId("model-provider-template-item-fixture-api").click();
    assert.deepEqual(await page.evaluate(() => window.__providerAccounts.apiCreates), [
      "fixture-api",
    ]);
    await oauth.click();
    await page.getByTestId("oauth-channel-fixture").click();
    await page.getByRole("dialog", { name: "Fixture OAuth", exact: true }).waitFor();
    await page.getByRole("button", { name: "开始授权", exact: true }).click();
    await page.getByLabel("授权码", { exact: true }).waitFor();
    assert.equal((await page.evaluate(() => window.__providerAccounts.opened)).length, 1);
    await page.getByLabel("授权码", { exact: true }).fill("fixture-code-one");
    await page.getByRole("button", { name: "完成授权", exact: true }).click();
    await page.getByTestId("oauth-account-account-1").waitFor();
    await page.getByRole("button", { name: "开始授权", exact: true }).click();
    await page.getByLabel("授权码", { exact: true }).fill("fixture-code-two");
    await page.getByRole("button", { name: "完成授权", exact: true }).click();
    const second = page.getByTestId("oauth-account-account-2");
    await second.waitFor();
    assert.equal(await page.locator("[data-oauth-account]").count(), 2);
    await second.getByRole("button", { name: "刷新模型", exact: true }).click();
    await page.waitForFunction(() => window.__providerAccounts.refreshes.includes("account-2"));
    await second.getByRole("switch").click();
    await page.waitForFunction(() => window.__providerAccounts.accounts[1]?.enabled === false);
    await page.getByRole("button", { name: "开始授权", exact: true }).click();
    await page.getByLabel("授权码", { exact: true }).waitFor();
    await page.getByRole("button", { name: "取消授权", exact: true }).click();
    await page.waitForFunction(() => window.__providerAccounts.cancelled.length === 1);
    assert.equal(await page.locator("[data-oauth-account]").count(), 2);
    await second.getByRole("button", { name: "删除账号", exact: true }).click();
    await second.waitFor({ state: "detached" });
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("data-testid") === "oauth-channel-fixture",
    );
    assert.equal(
      await page
        .getByTestId("oauth-channel-fixture")
        .evaluate((element) => element === document.activeElement),
      true,
    );
    await api.click();
    await page.getByTestId("model-provider-template-item-fixture-api").waitFor();
    assert.deepEqual(await page.evaluate(() => window.__providerAccounts.apiConfig), {
      apiKey: "fixture-existing-key",
      model: "fixture-existing-model",
      enabled: false,
    });
  },
);

test("OAuth picker is usable in English on a narrow screen", { timeout: 90_000 }, async (t) => {
  const { browser, port, diagnostics } = await startWorkflowProgressBrowser(t);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (entry) => {
    if (entry.type() === "error") errors.push(entry.text());
  });
  t.after(() => assert.deepEqual(errors, [], diagnostics()));
  await page.goto(`http://127.0.0.1:${port}/test/fixtures/provider-accounts.html?locale=en-US`);
  await page.getByRole("tab", { name: "OAuth", exact: true }).click();
  await page.getByTestId("oauth-channel-fixture").click();
  const dialog = page.getByRole("dialog", { name: "Fixture OAuth", exact: true });
  await dialog.waitFor();
  await page.getByRole("button", { name: "Start authorization", exact: true }).click();
  await page.getByLabel("Authorization code", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  await page.waitForFunction(() => window.__providerAccounts.cancelled.length === 1);
  assert.equal(await page.evaluate(() => window.__providerAccounts.accounts.length), 0);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
  );
  assert.deepEqual(errors, [], diagnostics());
});

test(
  "OAuth dialog blocks close after cancellation failure and restores focus after retry",
  { timeout: 90_000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(10_000);
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/provider-accounts.html?theme=light`);
    await page.getByRole("tab", { name: "OAuth", exact: true }).click();
    const trigger = page.getByTestId("oauth-channel-fixture");
    const top = await trigger.evaluate((element) => element.getBoundingClientRect().top);
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Fixture OAuth", exact: true });
    await dialog.getByRole("button", { name: "开始授权", exact: true }).click();
    await dialog.getByLabel("授权码", { exact: true }).waitFor();
    await page.evaluate(() => {
      window.__providerAccounts.failNextCancel = true;
    });
    await page.keyboard.press("Escape");
    await dialog.getByRole("alert").waitFor();
    assert.equal(await dialog.getByTestId("oauth-authorization-pending").count(), 1);
    const bounds = await dialog.boundingBox();
    assert.ok(
      bounds.x >= 0 &&
        bounds.x + bounds.width <= 390 &&
        bounds.y >= 0 &&
        bounds.y + bounds.height <= 844,
    );
    await mkdir(".tmp/provider-accounts", { recursive: true });
    await page.screenshot({ path: ".tmp/provider-accounts/dialog-mobile-light.png" });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("data-testid") === "oauth-channel-fixture",
    );
    assert.equal(await trigger.evaluate((element) => element.getBoundingClientRect().top), top);
    assert.equal(await page.evaluate(() => window.__providerAccounts.accounts.length), 0);
  },
);

test(
  "OAuth dialog imports multiple files and uses local sign-in only when requested",
  { timeout: 90_000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/provider-accounts.html?sources=1`);
    await page.getByRole("tab", { name: "OAuth", exact: true }).click();
    await page.getByTestId("oauth-channel-fixture").click();
    const dialog = page.getByRole("dialog", { name: "Fixture OAuth", exact: true });
    await dialog.getByRole("button", { name: "文件导入", exact: true }).click();
    await dialog
      .getByText("Import fixture account exports. Existing credentials are read only.")
      .waitFor();
    const upload = dialog.getByLabel("选择凭据文件", { exact: true });
    await upload.setInputFiles([
      {
        name: "one.json",
        mimeType: "application/json",
        buffer: Buffer.from(
          JSON.stringify({ name: "Imported One", refresh: "fixture-secret-one" }),
        ),
      },
      {
        name: "broken.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("fixture-sensitive-invalid-content"),
      },
    ]);
    await dialog
      .getByLabel("粘贴凭据内容", { exact: true })
      .fill(JSON.stringify({ name: "Imported Two", refresh: "fixture-secret-two" }));
    await dialog.getByRole("button", { name: "导入账号", exact: true }).click();
    await dialog
      .getByTestId("oauth-import-results")
      .getByText("已添加", { exact: true })
      .first()
      .waitFor();
    assert.equal(await dialog.locator("[data-oauth-account]").count(), 2);
    assert.match(await dialog.getByTestId("oauth-import-results").innerText(), /凭据格式无效/);
    assert.doesNotMatch(
      await dialog.innerText(),
      /fixture-secret|fixture-sensitive-invalid-content/,
    );
    await upload.setInputFiles({
      name: "one.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ name: "Imported One" })),
    });
    await dialog.getByRole("button", { name: "导入账号", exact: true }).click();
    await dialog.getByTestId("oauth-import-results").getByText("已存在", { exact: true }).waitFor();
    assert.equal(await dialog.locator("[data-oauth-account]").count(), 2);
    await upload.setInputFiles({
      name: "large.txt",
      mimeType: "text/plain",
      buffer: Buffer.alloc(4 * 1024 * 1024 + 1, "x"),
    });
    await dialog.getByRole("alert").getByText("每个凭据文件不能超过 4 MiB。").waitFor();
    assert.equal(await page.evaluate(() => window.__providerAccounts.importReads), 2);
    assert.equal(await page.evaluate(() => window.__providerAccounts.localReads), 0);
    await dialog.getByRole("button", { name: "本机登录", exact: true }).click();
    await dialog.getByText("Reads the selected Host's fixture CLI sign-in.").waitFor();
    await dialog.getByTestId("oauth-account-account-3").waitFor();
    assert.equal(await page.evaluate(() => window.__providerAccounts.localReads), 1);
  },
);

test(
  "OAuth imports reject oversized totals and discard file reads after a Host change",
  { timeout: 120_000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(10_000);
    await page.goto(
      `http://127.0.0.1:${port}/test/fixtures/provider-accounts.html?sources=1&theme=light`,
    );
    await page.getByRole("tab", { name: "OAuth", exact: true }).click();
    await page.getByTestId("oauth-channel-fixture").click();
    const dialog = page.getByRole("dialog", { name: "Fixture OAuth", exact: true });
    await dialog.getByRole("button", { name: "文件导入", exact: true }).click();
    const files = dialog.locator('input[type="file"]');
    await files.setInputFiles(
      ["one", "two", "three"].map((name) => ({
        name: `${name}.json`,
        mimeType: "application/json",
        buffer: Buffer.alloc(3 * 1024 * 1024, 32),
      })),
    );
    await dialog.getByRole("alert").filter({ hasText: "8 MiB" }).waitFor();
    assert.equal(await page.evaluate(() => window.__providerAccounts.importReads), 0);
    await page.evaluate(() => {
      File.prototype.text = async () => {
        throw new Error("fixture read denied");
      };
    });
    await files.setInputFiles({
      name: "fixture.json",
      mimeType: "application/json",
      buffer: Buffer.from('{"name":"safe fixture"}'),
    });
    await dialog.getByRole("button", { name: "导入账号", exact: true }).click();
    await dialog.getByRole("alert").filter({ hasText: "无法读取" }).waitFor();
    await page.evaluate(() => {
      File.prototype.text = () =>
        new Promise((resolve) => {
          window.__finishFileRead = () => resolve('{"name":"late fixture"}');
        });
    });
    await files.setInputFiles({
      name: "late.json",
      mimeType: "application/json",
      buffer: Buffer.from("fixture"),
    });
    await dialog.getByRole("button", { name: "导入账号", exact: true }).click();
    await page.waitForFunction(() => typeof window.__finishFileRead === "function");
    await page.evaluate(() => window.__providerAccounts.switchHost());
    await dialog.getByRole("button", { name: "开始授权", exact: true }).waitFor();
    await page.evaluate(async () => {
      window.__finishFileRead();
      await Promise.resolve();
    });
    assert.equal(await page.evaluate(() => window.__providerAccounts.importReads), 0);
    assert.equal(await page.evaluate(() => window.__providerAccounts.alternateHostReads), 0);
    await dialog.getByRole("button", { name: "文件导入", exact: true }).click();
    assert.equal(await dialog.getByLabel("粘贴凭据内容", { exact: true }).inputValue(), "");
    await page.screenshot({ path: ".tmp/provider-accounts/import-mobile-light.png" });
  },
);

test(
  "OAuth transport failures preserve the attempt and can resume or cancel",
  { timeout: 90_000 },
  async (t) => {
    const { browser, port, diagnostics } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, [], diagnostics()));
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/provider-accounts.html`);
    await page.getByRole("tab", { name: "OAuth", exact: true }).click();
    await page.getByTestId("oauth-channel-fixture").click();
    const start = page.getByRole("button", { name: "开始授权", exact: true });
    await start.click();
    await page.getByTestId("oauth-authorization-pending").waitFor();
    await page.evaluate(() => {
      window.__providerAccounts.failNextCancel = true;
    });
    const cancel = page.getByRole("button", { name: "取消授权", exact: true });
    await cancel.click();
    await page.getByRole("alert").waitFor();
    assert.equal(await page.getByTestId("oauth-authorization-pending").count(), 1);
    assert.equal(await page.evaluate(() => window.__providerAccounts.accounts.length), 0);
    await cancel.click();
    await page.getByTestId("oauth-authorization-pending").waitFor({ state: "detached" });
    await page.evaluate(() => {
      window.__providerAccounts.failNextPoll = true;
    });
    await start.click();
    await page.getByRole("alert").waitFor();
    await page.evaluate(() => {
      window.__providerAccounts.completeOnPoll = true;
    });
    await page.getByRole("alert").getByRole("button").click();
    await page.getByTestId("oauth-account-account-1").waitFor();
    await page.getByTestId("oauth-authorization-pending").waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => window.__providerAccounts.cancelled.length), 1);
  },
);

test(
  "OAuth CLI dependency failures are localized and unknown errors never expose upstream text",
  { timeout: 90_000 },
  async (t) => {
    const { browser, port, diagnostics } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, [], diagnostics()));
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/provider-accounts.html`);
    await page.getByRole("tab", { name: "OAuth", exact: true }).click();
    await page.getByTestId("oauth-channel-fixture").click();
    await page.evaluate(() => {
      window.__providerAccounts.startFailure = "OAUTH_CLAUDE_CLI_REQUIRED";
    });
    await page.getByRole("button", { name: "开始授权", exact: true }).click();
    await page.getByRole("alert").waitFor();
    assert.match(
      await page.getByRole("alert").textContent(),
      /请安装 Claude Code CLI.*LCODE_CLAUDE_BIN/u,
    );
    assert.doesNotMatch(await page.locator("body").textContent(), /OAUTH_CLAUDE_CLI_REQUIRED/u);

    await page.goto(`http://127.0.0.1:${port}/test/fixtures/provider-accounts.html?locale=en-US`);
    await page.getByRole("tab", { name: "OAuth", exact: true }).click();
    await page.getByTestId("oauth-channel-fixture").click();
    const start = page.getByRole("button", { name: "Start authorization", exact: true });
    const complete = page.getByRole("button", { name: "Complete authorization", exact: true });
    for (const error of ["OAUTH_GROK_CLI_REQUIRED", "fixture-sensitive-upstream-response"]) {
      await page.evaluate((value) => {
        window.__providerAccounts.completionFailure = value;
      }, error);
      await start.click();
      await page.getByLabel("Authorization code", { exact: true }).fill("fixture-code");
      await complete.click();
      await page.getByRole("alert").waitFor();
      const content = await page.getByRole("alert").textContent();
      assert.match(
        content,
        error === "OAUTH_GROK_CLI_REQUIRED"
          ? /Install the Grok Build CLI/u
          : /Authorization failed/u,
      );
      assert.equal((await page.locator("body").textContent()).includes(error), false);
      assert.equal(await page.evaluate(() => window.__providerAccounts.accounts.length), 0);
    }
  },
);
