import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright-core";

test(
  "真实父/子统计组件：隐藏输出、请求均速、实时速度与窄屏布局",
  { timeout: 120_000 },
  async (t) => {
    const socket = createServer();
    socket.listen(0, "127.0.0.1");
    await once(socket, "listening");
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    const server = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./bin/vite.js", import.meta.resolve("vite/package.json"))),
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--strictPort",
      ],
      { cwd: fileURLToPath(new URL("../", import.meta.url)), windowsHide: true, stdio: "pipe" },
    );
    let browser;
    let output = "";
    server.stdout.on("data", (chunk) => {
      output += chunk;
    });
    server.stderr.on("data", (chunk) => {
      output += chunk;
    });
    t.after(async () => {
      await browser?.close();
      if (process.platform === "win32") {
        const stop = spawn("taskkill", ["/PID", String(server.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        await once(stop, "exit");
      } else {
        server.kill("SIGTERM");
        if (server.exitCode === null) await once(server, "exit");
      }
    });
    const ready = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 45_000);
      const check = () => {
        if (output.includes("Local:")) {
          clearTimeout(timeout);
          resolve(true);
        }
      };
      server.stdout.on("data", check);
      server.once("exit", () => {
        clearTimeout(timeout);
        resolve(false);
      });
      check();
    });
    assert.ok(ready, output);
    browser = await chromium.launch({
      headless: true,
      ...(process.env.LCODE_TEST_BROWSER_PATH
        ? { executablePath: process.env.LCODE_TEST_BROWSER_PATH }
        : {}),
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/session-output-speed.html`);
    const parent = page.getByTestId("parent");
    const child = page.getByTestId("read-only-session-token-stats");
    const scenario = (value) =>
      page.evaluate((value) => globalThis.__speedFixture.scenario(value), value);
    await parent.getByTestId("session-output-speed-pending").waitFor();
    assert.match(await parent.innerText(), /等待用量/);
    assert.match(await child.innerText(), /实时速度不可用/);

    await scenario("average");
    await parent.getByTestId("session-output-speed").waitFor();
    assert.match(await parent.innerText(), /均 50\/s/);
    assert.match(await child.innerText(), /最近请求平均速度 50 token\/s/);
    assert.equal(await child.getByTestId("session-output-speed-pending").count(), 0);
    await scenario("pending-average");
    await child.getByTestId("session-output-speed-pending").waitFor();
    assert.match(await child.innerText(), /最近请求平均速度/);
    await scenario("live");
    await child.locator('[data-speed-kind="live"]').waitFor();
    assert.match(await parent.innerText(), /20\/s/);
    assert.match(await child.innerText(), /可见输出速度（估算） 20 token\/s/);
    await scenario("completed");
    await child.locator('[data-speed-kind="average"]').waitFor();
    assert.equal(await child.locator('[data-speed-kind="live"]').count(), 0);
    await scenario("other");
    await parent.getByTestId("session-output-speed-pending").waitFor();
    assert.equal(await child.getByTestId("session-output-speed").count(), 0);

    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      for (const locale of ["zh-CN", "en-US"]) {
        await page.evaluate((locale) => globalThis.__speedFixture.locale(locale), locale);
        for (const dark of [false, true]) {
          await page.evaluate((dark) => {
            document.documentElement.className = dark ? "dark theme-zai-dark" : "theme-zai-light";
          }, dark);
          await scenario("pending-average");
          const pending = child.getByTestId("session-output-speed-pending");
          await pending.waitFor();
          assert.match(
            await child.innerText(),
            locale === "zh-CN" ? /实时速度不可用/ : /live speed unavailable/,
          );
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
          // 桌面用 hover，触摸设备用 pointerdown 打开同一面板，检查分组明细也不溢出。
          const trigger = parent.locator('button[data-chat-toolbar-popover-trigger="true"]');
          await trigger.hover();
          const panel = page.locator('[data-slot="hover-card-content"]');
          await panel.waitFor();
          await panel.evaluate(async (element) => {
            await Promise.all(element.getAnimations().map((animation) => animation.finished));
          });
          assert.match(
            await panel.innerText(),
            locale === "zh-CN" ? /子代理输出速度/ : /Subagent output speed/,
          );
          const bounds = await panel.boundingBox();
          assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
          if (process.env.LCODE_TEST_SCREENSHOT_DIR && locale === "zh-CN" && dark) {
            await page.screenshot({
              path: `${process.env.LCODE_TEST_SCREENSHOT_DIR}/speed-${width}.png`,
            });
          }
          await page.mouse.move(0, 799);
        }
      }
    }
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 800 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      const phone = await mobile.newPage();
      phone.on("pageerror", (error) => errors.push(error.message));
      await phone.goto(`http://127.0.0.1:${port}/test/fixtures/session-output-speed.html`);
      await phone.getByTestId("session-output-speed-pending").first().waitFor();
      await phone.evaluate(() => globalThis.__speedFixture.scenario("pending-average"));
      await phone
        .getByTestId("parent")
        .locator('button[data-chat-toolbar-popover-trigger="true"]')
        .tap();
      const panel = phone.locator('[data-slot="hover-card-content"]');
      await panel.waitFor();
      assert.match(await panel.innerText(), /子代理输出速度/);
      assert.equal(
        await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
    } finally {
      await mobile.close();
    }
    assert.deepEqual(errors, []);
  },
);
