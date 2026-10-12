import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "OAuth models reuse complete configuration and preserve overrides after refresh",
  { timeout: 120_000 },
  async (t) => {
    const { browser, port, diagnostics } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, [], diagnostics()));
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/provider-accounts.html?navigation=1`);
    await page.getByRole("button", { name: "Fixture OAuth pool", exact: true }).click();
    const accountDialog = page.getByTestId("oauth-provider-details");
    await accountDialog.waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
    await accountDialog.getByRole("tab", { name: "模型配置", exact: true }).click();
    await accountDialog.getByRole("button", { name: "编辑模型配置", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "编辑模型配置", exact: true });
    await editor.getByLabel("上下文窗口", { exact: true }).fill("196608");
    await editor.getByLabel("最大输出 Token", { exact: true }).fill("16384");
    await editor.locator("[data-model-advanced-trigger]").click();
    await editor.locator('[data-model-advanced-trigger][aria-expanded="true"]').waitFor();
    await editor.locator("[data-model-interaction-protocol]").waitFor();
    await editor.locator('[data-model-input-modality="image"]').click();
    await editor.locator("[data-model-reasoning-level-add]").click();
    await editor.locator("[data-model-reasoning-level-input]").fill("xhigh");
    await editor.locator("[data-model-reasoning-level-input]").press("Enter");
    const mapping = '{"reasoning": {"effort": reasoningLevel}}';
    await editor.locator("[data-model-json-slot] textarea").fill(mapping);
    await editor.getByRole("button", { name: "保存", exact: true }).click();
    await editor.waitFor({ state: "detached" });
    await page.waitForFunction(() => window.__providerAccounts.modelSaves.length === 1);
    const saved = await page.evaluate(() => window.__providerAccounts.modelSaves[0]);
    assert.equal(saved.personalConfig.properties.contextWindow, 196608);
    assert.equal(saved.personalConfig.properties.inputFormat.supportsImage, true);
    assert.equal(saved.personalConfig.optionSpecs.maxOutputTokens.max, 16384);
    assert.deepEqual(saved.personalConfig.optionSpecs.reasoningLevel.values, [
      "low",
      "high",
      "xhigh",
    ]);
    assert.equal(saved.personalConfig.optionSpecs.reasoningLevel.map, mapping);
    await accountDialog.getByRole("button", { name: "刷新模型", exact: true }).click();
    await page.waitForFunction(() => window.__providerAccounts.refreshes.length === 2);
    await accountDialog.getByRole("button", { name: "同步模型", exact: true }).click();
    const catalog = page.getByRole("dialog", { name: "同步模型", exact: true });
    await catalog.getByText("fixture-model", { exact: true }).waitFor();
    await page.waitForFunction(() => window.__providerAccounts.refreshes.length === 4);
    assert.equal(await page.evaluate(() => window.__providerAccounts.apiCatalogReads), 0);
    await catalog
      .locator('[data-slot="dialog-footer"]')
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    await catalog.waitFor({ state: "detached" });
    await accountDialog.getByRole("switch").click();
    await page.waitForFunction(() => window.__providerAccounts.modelEnabled === false);
    await accountDialog.getByRole("button", { name: "编辑模型配置", exact: true }).click();
    await editor.waitFor();
    assert.equal(await editor.getByLabel("上下文窗口", { exact: true }).inputValue(), "196608");
    assert.equal(await editor.getByLabel("最大输出 Token", { exact: true }).inputValue(), "16384");
    await editor.locator("[data-model-advanced-trigger]").click();
    await editor.locator('[data-model-advanced-trigger][aria-expanded="true"]').waitFor();
    await editor.locator("[data-model-json-slot] textarea").scrollIntoViewIfNeeded();
    await page.mouse.move(10, 10);
    assert.equal(await editor.locator("[data-model-json-slot] textarea").inputValue(), mapping);
    await mkdir(".tmp/provider-accounts", { recursive: true });
    await editor.evaluate((element) =>
      Promise.all(
        element
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished.catch(() => {})),
      ),
    );
    await editor.locator("[data-model-json-slot] textarea").scrollIntoViewIfNeeded();
    await page.screenshot({ path: ".tmp/provider-accounts/model-editor-desktop-dark.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await editor.locator("[data-model-json-slot] textarea").scrollIntoViewIfNeeded();
    const mobileBounds = await editor.boundingBox();
    assert.ok(mobileBounds.x >= 0 && mobileBounds.x + mobileBounds.width <= 390);
    assert.equal(
      await editor.evaluate((element) => element.scrollWidth <= element.clientWidth),
      true,
    );
    await page.screenshot({ path: ".tmp/provider-accounts/model-editor-mobile-dark.png" });
    await editor.getByRole("button", { name: "取消", exact: true }).click();
    await editor.waitFor({ state: "detached" });
    await accountDialog.waitFor();
    await accountDialog.getByRole("tab", { name: "已登录账号", exact: true }).click();
    assert.equal(await accountDialog.locator("[data-oauth-account]").count(), 2);
    const account = accountDialog.getByTestId("oauth-account-account-1");
    await account.getByText("授权已更新。", { exact: true }).waitFor();
    await account.getByRole("button", { name: "账号额度", exact: true }).click();
    await account.getByTestId("quota-account-1").waitFor();
  },
);
