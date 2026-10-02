import assert from "node:assert/strict";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "100k-key checks remain pageable, stoppable and closeable, preserving only confirmed results",
  { timeout: 180_000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    let mode = "hold";
    let requests = 0;
    let failed = 0;
    let partialReplies = 0;
    const waiting = [];
    const waitForRequests = (count) =>
      requests >= count
        ? Promise.resolve()
        : new Promise((resolve) => waiting.push({ count, resolve }));
    page.on("requestfailed", (request) => {
      if (request.url().includes("/__keyprobe/")) failed++;
    });
    await page.route("**/__keyprobe/models", async (route) => {
      requests++;
      for (const waiter of waiting) if (requests >= waiter.count) waiter.resolve();
      const index = Number(route.request().headers().authorization?.split("-").at(-1));
      if (mode === "mixed" || (mode === "partial" && partialReplies++ < 3)) {
        await route.fulfill({ status: [403, 200, 500][index % 3], body: "" }).catch(() => {});
      }
    });
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/api-key-probe.html`);
    const dialog = page.getByRole("dialog");
    const progress = page.locator("[data-api-key-probe-progress]");
    const click = (name) => dialog.getByRole("button", { name, exact: true }).click();
    const idle = () =>
      page.waitForFunction(
        () => !document.querySelector('[role="dialog"] button[aria-expanded]')?.disabled,
      );
    const noFlight = () => page.waitForFunction(() => window.__keyProbe.inFlight() === 0);
    const seed = async (count) => {
      await page.evaluate((count) => window.__keyProbe.seed(count), count);
      await dialog.waitFor({ state: "hidden" });
      await page.evaluate(() => window.__keyProbe.reopen());
      await dialog.waitFor();
    };
    await dialog.locator("[data-api-key-row]").first().waitFor();
    assert.deepEqual(pageErrors, []);
    assert.equal(await dialog.locator("[data-api-key-row]").count(), 25);
    await click("并发检测");
    await page.waitForFunction(() => window.__keyProbe.inFlight() === 1);
    await waitForRequests(8);
    assert.equal(requests, 8);
    assert.equal(await dialog.getByRole("button", { name: "取消", exact: true }).isEnabled(), true);
    await page.evaluate(() => {
      window.__probeTasks = [];
      window.__probeObserver = new PerformanceObserver((list) =>
        window.__probeTasks.push(...list.getEntries().map((entry) => entry.duration)),
      );
      window.__probeObserver.observe({ type: "longtask" });
    });
    await click("末页");
    assert.equal(await dialog.getByRole("spinbutton").inputValue(), "4000");
    await click("首页");
    await dialog.getByRole("spinbutton").fill("2000");
    await dialog.getByRole("spinbutton").press("Enter");
    assert.equal(await dialog.getByRole("spinbutton").inputValue(), "2000");
    await click("停止检测");
    await idle();
    assert.match(await progress.innerText(), /检测已停止：0 \/ 100000/);
    assert.equal(requests, 8);
    await page.waitForFunction(() => window.__keyProbe.inFlight() === 0);
    assert.equal(await dialog.locator("[data-api-key-row]").count(), 25);
    const longTasks = await page.evaluate(() => {
      window.__probeObserver.disconnect();
      return window.__probeTasks.map(Math.round);
    });
    t.diagnostic(`100k steady-state pagination/stop Long Tasks: ${JSON.stringify(longTasks)}`);

    let before = requests;
    await click("并发检测");
    await page.waitForFunction(() => window.__keyProbe.inFlight() === 1);
    await waitForRequests(before + 8);
    assert.equal(requests - before, 8);
    await click("取消");
    await dialog.waitFor({ state: "hidden" });
    await noFlight();
    assert.ok(failed >= 8, "closing must abort real fetch requests");
    await page.evaluate(() => window.__keyProbe.reopen());
    await dialog.waitFor();
    assert.equal(await progress.count(), 0);

    before = requests;
    await click("并发检测");
    await page.waitForFunction(() => window.__keyProbe.inFlight() === 1);
    await waitForRequests(before + 8);
    await page.evaluate(() => window.__keyProbe.switchScope());
    await noFlight();
    assert.equal(requests - before, 8);
    assert.equal(await progress.count(), 0, "old results must not enter the new scope");

    mode = "mixed";
    await seed(60);
    await click("并发检测");
    await idle();
    assert.match(await progress.innerText(), /检测完成：60 \/ 60/);
    assert.match(await progress.innerText(), /有效 20 · 无效 20 · 失败 20/);
    assert.equal(
      await page.evaluate(
        () => window.__keyProbe.saved().filter((key) => key.enabled === false).length,
      ),
      40,
    );
    await click("末页");
    await click("删除无效 Key（20）");
    await idle();
    assert.equal(await dialog.getByRole("spinbutton").inputValue(), "2");

    mode = "partial";
    partialReplies = 0;
    await seed(100_000);
    await click("并发检测");
    await page.waitForFunction(() =>
      document
        .querySelector("[data-api-key-probe-progress]")
        ?.textContent.includes("已检测 3 / 100000"),
    );
    await click("停止检测");
    await idle();
    assert.match(await progress.innerText(), /检测已停止：3 \/ 100000/);
    assert.match(await progress.innerText(), /有效 1 · 无效 1 · 失败 1/);
    assert.equal(
      await dialog.getByRole("button", { name: "删除无效 Key（1）", exact: true }).isEnabled(),
      true,
    );
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await dialog.getByRole("button", { name: "取消", exact: true }).isEnabled(), true);
    await click("取消");
    await dialog.waitFor({ state: "hidden" });

    mode = "hold";
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => window.__keyProbe.reopen());
    await dialog.waitFor();
    await click("并发检测");
    await page.waitForFunction(() => window.__keyProbe.inFlight() === 1);
    await page.evaluate(() => window.__keyProbe.unmount());
    await noFlight();
    await dialog.waitFor({ state: "hidden" });
  },
);
