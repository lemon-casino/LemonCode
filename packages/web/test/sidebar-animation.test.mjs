import assert from "node:assert/strict";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "inactive sidebar line animation does not commit redundant state when its child changes",
  { timeout: 60000 },
  async (t) => {
    const { browser, port, diagnostics } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/sidebar-animation.html`);
    await page
      .getByTestId("workspace-row")
      .waitFor()
      .catch(async () =>
        assert.fail(
          JSON.stringify({
            errors,
            diagnostics: diagnostics().slice(-3000),
            body: (await page.locator("body").innerText()).slice(0, 1000),
          }),
        ),
      );
    const changes = 60;
    const commits = await page.evaluate(async (changes) => {
      // 用浏览器帧等待 React 自身结算，不固定睡眠；测每次真实 props 更新后的 commit 数。
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => {
        const observer = new IntersectionObserver(() => {
          observer.disconnect();
          resolve();
        });
        observer.observe(document.querySelector("[data-beam]"));
      });
      await frame();
      await frame();
      // 首次行更新仍可能带上 IntersectionObserver 的可见性结算；先完成这笔真实初始化。
      document.querySelector('[data-testid="refresh-row"]').click();
      await frame();
      await frame();
      const start = Number(document.body.dataset.beamCommits);
      for (let i = 0; i < changes; i++) {
        document.querySelector('[data-testid="refresh-row"]').click();
        await frame();
      }
      await frame();
      return Number(document.body.dataset.beamCommits) - start;
    }, changes);
    assert.equal(
      commits,
      changes,
      `line mode produced ${commits - changes} redundant commits; ${await page.evaluate(() => document.body.dataset.beamTrace)}`,
    );
    assert.deepEqual(errors, []);
    assert.equal(await page.getByRole("alert").count(), 0);
  },
);

test(
  "production workspace rows survive theme, size, reconnect and menu changes",
  { timeout: 90000 },
  async (t) => {
    const { browser, port, diagnostics } = await startWorkflowProgressBrowser(t);
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      page.setDefaultTimeout(10000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.goto(`http://127.0.0.1:${port}/test/fixtures/sidebar-animation.html?rows`);
      const row = page.getByTestId("actual-sidebar-row");
      await row.waitFor().catch(async () =>
        assert.fail(
          JSON.stringify({
            errors,
            diagnostics: diagnostics().slice(-3000),
            body: (await page.locator("body").innerText()).slice(0, 1000),
          }),
        ),
      );
      for (const mode of ["local", "connecting", "failed", "idle", "connected"]) {
        await page.getByTestId(`mode-${mode}`).click();
        await page.waitForFunction(
          (active) =>
            document
              .querySelector('[data-testid="actual-sidebar-row"] [data-beam]')
              ?.hasAttribute("data-active") === active,
          mode === "connecting",
        );
        for (const theme of [
          "zai-dark",
          "zai-light",
          "sepia-light",
          "midnight-blue",
          "forest-dark",
          "cinnabar",
          "inkpurple",
        ]) {
          await page.getByTestId(`theme-${theme}`).click();
          await page.getByTestId("refresh-actual-row").click();
          assert.equal(await row.locator("[data-beam]").count(), 1);
          assert.equal(await page.getByRole("alert").count(), 0);
        }
      }
      await page.getByTestId("mode-idle").click();
      await row.getByRole("button", { name: "重新连接", exact: true }).click();
      await row.locator("[data-beam][data-active]").waitFor();
      await page.getByTestId("mode-local").click();
      await page.getByTestId("large-type").click();
      const trigger = row.locator('[data-testid^="workspace-item"]');
      await trigger.click();
      assert.equal(await trigger.getAttribute("aria-expanded"), "true");
      await trigger.click();
      assert.equal(await trigger.getAttribute("aria-expanded"), "false");
      await row.hover();
      const menu = row.getByRole("button", { name: "更多", exact: true });
      await menu.click();
      await page.getByRole("menu").waitFor();
      await page.keyboard.press("Escape");
      assert.deepEqual(errors, []);
      await page.close();
    }
  },
);
