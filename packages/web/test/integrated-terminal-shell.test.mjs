import assert from "node:assert/strict";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "custom shell file/directory selection, failures and reset on desktop and phone",
  { timeout: 90_000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`http://127.0.0.1:${port}/test/fixtures/integrated-terminal-shell.html`);
      const saves = () => page.evaluate(() => window.__shellFixture.saves.length);
      const savedPath = () => page.evaluate(() => window.__shellFixture.saves.at(-1)?.path);
      const trigger = page.getByRole("button", { name: "内置终端 Shell", exact: true });
      const panel = page.getByRole("dialog");
      // 面板关闭有退出动画，断言前必须等它真正消失。
      const closed = () => panel.waitFor({ state: "hidden" });
      await trigger.click();
      await panel.getByRole("button", { name: "选择可执行文件", exact: true }).click();
      await page.waitForFunction(() => window.__shellFixture.saves.length === 1);
      assert.equal(await savedPath(), "/opt/自定义 Shell/my-shell");
      await closed();
      assert.match(await trigger.innerText(), /my-shell/);
      await trigger.click();
      await panel.getByRole("button", { name: "重新探测 Shell", exact: true }).click();
      assert.match(await trigger.innerText(), /my-shell/);
      await page.evaluate(() => {
        window.__shellFixture.file = null;
      });
      await panel.getByRole("button", { name: "选择可执行文件", exact: true }).click();
      assert.equal(await saves(), 1);
      await panel.getByRole("button", { name: "选择目录", exact: true }).click();
      const candidates = panel.getByRole("group", { name: "目录中的 Shell" });
      await candidates.waitFor();
      assert.equal(await saves(), 1);
      await panel.getByRole("option", { name: /fish/ }).click();
      await page.waitForFunction(() => window.__shellFixture.saves.length === 2);
      assert.equal(await savedPath(), "/opt/shells/bin/fish");
      await trigger.click();
      const input = panel.getByRole("combobox");
      await input.fill("/missing/shell");
      await input.press("Enter");
      await panel.getByRole("alert").waitFor();
      assert.equal(await saves(), 2);
      await page.evaluate(() => {
        window.__shellFixture.failSave = true;
      });
      await input.fill("/opt/自定义 Shell/my-shell");
      await panel.getByRole("option", { name: /应用路径/ }).click();
      await panel
        .getByRole("alert")
        .filter({ hasText: /无法保存/ })
        .waitFor();
      assert.equal(await saves(), 2);
      await page.evaluate(() => {
        window.__shellFixture.failSave = false;
      });
      await input.fill("");
      await panel.getByRole("option", { name: "自动选择", exact: true }).click();
      await page.waitForFunction(() => window.__shellFixture.saves.length === 3);
      assert.equal(await page.evaluate(() => window.__shellFixture.saves.at(-1).mode), "auto");
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
    }
    await page.goto(
      `http://127.0.0.1:${port}/test/fixtures/integrated-terminal-shell.html?web&english`,
    );
    const trigger = page.getByRole("button", { name: "Integrated terminal shell", exact: true });
    await trigger.click();
    const panel = page.getByRole("dialog");
    assert.equal(
      await panel.getByRole("button", { name: "Choose executable", exact: true }).count(),
      0,
    );
    assert.equal(
      await panel.getByRole("button", { name: "Choose directory", exact: true }).count(),
      0,
    );
    const input = panel.getByRole("combobox");
    await input.fill("/opt/自定义 Shell/my-shell");
    await input.press("Enter");
    await page.waitForFunction(() => window.__shellFixture.saves.length === 1);
    await trigger.click();
    await page.evaluate(() => {
      window.__shellFixture.holdResolve = true;
    });
    await input.fill("/opt/shells");
    await input.press("Enter");
    await page.waitForFunction(() => window.__shellFixture.resolveCalls === 2);
    assert.equal(await input.isDisabled(), true);
    await page.getByRole("button", { name: "Unmount", exact: true }).click();
    await page.evaluate(() => window.__shellFixture.releaseResolve());
    // 让已释放的探测 Promise 完成微任务；卸载后不得提交保存。
    await page.evaluate(() => Promise.resolve());
    assert.equal(await page.evaluate(() => window.__shellFixture.saves.length), 1);
    assert.deepEqual(errors, []);
  },
);
