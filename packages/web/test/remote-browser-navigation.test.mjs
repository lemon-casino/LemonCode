import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright-core";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

const MEMORY_KEY = "lcode:remote-browser-navigation:v1";
async function assertLocation(page, path, task) {
  await page.waitForFunction(
    ({ path, task }) =>
      document.querySelector('[data-testid="path"]')?.textContent === path &&
      document.querySelector('[data-testid="task"]')?.textContent === task,
    { path, task },
  );
  assert.equal(await page.getByText("欢迎来到 LCode", { exact: true }).count(), 0);
}

test(
  "CF 浏览器位置在刷新、重开、浏览器重启及轻绑定失效后正确恢复",
  { timeout: 180_000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const url = `http://127.0.0.1:${port}/test/fixtures/remote-browser-navigation.html`;
    for (const width of [390, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      let page = await context.newPage();
      const errors = [];
      const observe = () => page.on("pageerror", (error) => errors.push(error.message));
      observe();
      await page.goto(url);
      await page.getByText("欢迎来到 LCode", { exact: true }).waitFor();
      await page.getByRole("button", { name: "进入", exact: true }).click();
      await assertLocation(page, "/default", "draft");
      await page.getByRole("button", { name: "选择 B2" }).click();
      await assertLocation(page, "/b", "b2");
      const saved = await page.evaluate((key) => localStorage.getItem(key), MEMORY_KEY);
      assert.equal(JSON.parse(saved).targets["device-a"].taskId, "b2");
      await page.reload();
      await assertLocation(page, "/b", "b2");
      await page.close();
      page = await context.newPage();
      observe();
      await page.goto(`${url}?room=another-room`);
      await assertLocation(page, "/b", "b2");

      // 关闭浏览器进程后，使用它保存的真实同源状态重新启动，不注入目标选择态。
      const state = await context.storageState();
      const relaunched = await chromium.launch({
        headless: true,
        ...(process.env.LCODE_TEST_BROWSER_PATH
          ? { executablePath: process.env.LCODE_TEST_BROWSER_PATH }
          : {}),
      });
      const recovered = await relaunched.newContext({ storageState: state });
      const recoveredPage = await recovered.newPage();
      await recoveredPage.goto(url);
      await assertLocation(recoveredPage, "/b", "b2");
      await relaunched.close();

      await page.goto(`${url}?hold`);
      await page.getByTestId("loading").waitFor();
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), MEMORY_KEY), saved);
      await page.evaluate(() => window.__navigationFixture.release());
      await assertLocation(page, "/b", "b2");
      await page.goto(`${url}?networkFailure`);
      await assertLocation(page, "/default", "draft");
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), MEMORY_KEY), saved);
      await page.goto(url);
      await assertLocation(page, "/b", "b2");

      await page.goto(`${url}?device=device-b`);
      await assertLocation(page, "/default", "draft");
      await page.goto(`${url}?deletedTask`);
      await assertLocation(page, "/b", "draft");
      await page.getByRole("button", { name: "选择 B2" }).click();
      await page.goto(`${url}?deletedProject`);
      await assertLocation(page, "/default", "draft");
      await page.goto(url);
      await page.getByRole("button", { name: "选择 B2" }).click();
      await page.getByRole("button", { name: "新建任务" }).click();
      await page.evaluate(() =>
        localStorage.setItem("lcode-v4-last-session:v1:/b", "stale-desktop-task"),
      );
      await page.reload();
      await assertLocation(page, "/b", "draft");
      assert.deepEqual(await page.evaluate(() => window.__navigationFixture.writes), []);
      assert.deepEqual(errors, []);
      await context.close();
    }
  },
);

test("真正 Root 只在首次显示欢迎，取消后重开也保留已进入记录", { timeout: 180_000 }, async (t) => {
  const { browser, port } = await startWorkflowProgressBrowser(t);
  const context = await browser.newContext();
  const page = await context.newPage();
  const url = `http://127.0.0.1:${port}/test/fixtures/remote-browser-navigation.html?root`;
  await page.goto(url);
  await page.getByText("欢迎来到 LCode", { exact: true }).waitFor();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.waitForFunction(
    (key) => JSON.parse(localStorage.getItem(key))?.hasEntered === true,
    MEMORY_KEY,
  );
  await page.reload();
  await page.waitForFunction(() => window.__navigationFixture.reads > 0);
  assert.equal(await page.getByText("欢迎来到 LCode", { exact: true }).count(), 0);
  await context.close();
});
