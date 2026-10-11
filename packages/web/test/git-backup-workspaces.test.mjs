import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test("Git backup workspace selection is explicit and durable", { timeout: 180_000 }, async (t) => {
  const { browser, port, diagnostics } = await startWorkflowProgressBrowser(t);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, [], diagnostics());
  });
  await page.goto(`http://127.0.0.1:${port}/test/fixtures/git-backup.html`);
  const rows = page.getByTestId("git-backup-workspaces").getByRole("checkbox");
  const count = page.getByTestId("accepted-workspace-count");
  const toggle = page.getByTestId("git-backup-enabled");
  async function selectedCount(value) {
    await count.filter({ hasText: new RegExp(`^${value}$`) }).waitFor();
    await page
      .locator('[data-testid="git-backup-workspace-select"]:not([disabled])')
      .first()
      .waitFor();
  }
  await rows.first().waitFor();
  assert.equal(await rows.count(), 3);
  assert.equal(await toggle.isDisabled(), true);
  await page.getByTestId("git-backup-save").click();
  await page.getByRole("status").filter({ hasText: "配置已保存" }).waitFor();
  assert.equal(await count.innerText(), "0");
  await rows.nth(1).click();
  await selectedCount(1);
  await rows.nth(2).click();
  await selectedCount(2);
  assert.equal(await rows.first().isChecked(), false);
  await toggle.click();
  await page.getByTestId("accepted-enabled").filter({ hasText: "true" }).waitFor();
  assert.equal(await count.innerText(), "2");
  await page.getByTestId("git-backup-save").click();
  await page.getByRole("status").filter({ hasText: "配置已保存" }).waitFor();
  assert.equal(await rows.first().isChecked(), false);
  await page.getByTestId("git-backup-oss-enabled").click();
  await page.getByTestId("accepted-oss-selected").filter({ hasText: "false" }).waitFor();
  await page.getByTestId("git-backup-oss-enabled").click();
  await page.getByTestId("accepted-oss-selected").filter({ hasText: "true" }).waitFor();
  assert.equal(await count.innerText(), "2");
  await page.reload();
  await rows.first().waitFor();
  assert.equal(await rows.first().isChecked(), false);
  assert.equal(await rows.nth(1).isChecked(), true);
  assert.equal(await rows.nth(2).isChecked(), true);

  await page.getByLabel("模拟下一次失败").selectOption("configure");
  await rows.first().click();
  await page.getByRole("alert").waitFor();
  assert.equal(await rows.first().isChecked(), false);
  await page.getByLabel("挂起请求").selectOption("configure");
  await rows.first().click();
  assert.equal(await rows.first().isChecked(), false);
  assert.equal(await rows.nth(1).isDisabled(), true);
  await page.getByTestId("fixture-release").click();
  await selectedCount(3);
  await page.getByLabel("挂起请求").selectOption("none");
  await rows.first().click();
  await selectedCount(2);
  await toggle.click();
  await page.getByTestId("accepted-enabled").filter({ hasText: "true" }).waitFor();
  await rows.nth(1).click();
  await selectedCount(1);
  await rows.nth(2).click();
  await selectedCount(0);
  assert.equal(await toggle.isChecked(), false);
  assert.equal(await toggle.isDisabled(), true);
  await page.getByLabel("模拟下一次失败").selectOption("readback");
  await rows.first().click();
  await page.getByRole("alert").waitFor();
  assert.equal(await rows.first().isChecked(), true);
  assert.equal(await toggle.isChecked(), false);
  await page.getByTestId("fixture-reopen").click();
  await rows.first().waitFor();
  assert.equal(await rows.first().isChecked(), true);

  const screenshots = fileURLToPath(
    new URL("../../../.lcode/component-quality/git-backup-workspaces/", import.meta.url),
  );
  await mkdir(screenshots, { recursive: true });
  await page
    .getByTestId("git-backup-workspaces")
    .screenshot({ path: `${screenshots}/desktop-zh-dark.png` });
  await page.setViewportSize({ width: 375, height: 900 });
  for (const theme of ["dark", "light"]) {
    await page.getByLabel("主题", { exact: true }).selectOption(theme);
    await page
      .getByTestId("git-backup-workspaces")
      .screenshot({ path: `${screenshots}/mobile-${theme}.png` });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
  }
  await rows.nth(1).focus();
  await page.keyboard.press("Space");
  await selectedCount(2);
  await page.getByLabel("语言", { exact: true }).selectOption("en-US");
  await page.getByRole("heading", { name: "Auto Backup Workspaces", exact: true }).waitFor();
  assert.equal(await rows.nth(1).isChecked(), true);
  for (const theme of ["dark", "light"]) {
    await page.getByLabel("主题", { exact: true }).selectOption(theme);
    await page
      .getByTestId("git-backup-workspaces")
      .screenshot({ path: `${screenshots}/mobile-en-${theme}.png` });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
  }
  await page.getByLabel("语言", { exact: true }).selectOption("zh-CN");
  await rows.first().waitFor();
  await page.getByLabel("挂起请求").selectOption("configure");
  await rows.nth(2).click();
  await page.getByLabel("连接", { exact: true }).selectOption("disconnected");
  await page.getByRole("status").filter({ hasText: "断连" }).waitFor();
  await page.getByTestId("fixture-release").click();
  await count.filter({ hasText: "3" }).waitFor();
  assert.equal(await rows.count(), 0);
  await page.getByLabel("挂起请求").selectOption("none");
  await page.getByLabel("连接", { exact: true }).selectOption("ready");
  await rows.first().waitFor();
  assert.equal(await rows.nth(2).isChecked(), true);
});
