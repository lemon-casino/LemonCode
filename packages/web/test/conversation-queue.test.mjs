import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { chromium } from "playwright-core";

test(
  "队列立即发送反馈和跨会话隔离（真实共享组件，无模型调用）",
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
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        windowsHide: true,
        stdio: "pipe",
      },
    );
    let output = "";
    let browser;
    server.stdout.on("data", (data) => {
      output += data.toString();
    });
    server.stderr.on("data", (data) => {
      output += data.toString();
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
        if (stripVTControlCharacters(output).includes("Local:")) {
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
    page.on("pageerror", (e) => errors.push(e.message));
    const url = `http://127.0.0.1:${port}/test/fixtures/conversation-queue.html`;
    const fixture = (method, ...args) =>
      page.evaluate(({ method, args }) => globalThis.__queueFixture[method](...args), {
        method,
        args,
      });

    await t.test("pending 锁行、同一帧重复点击不重发，成功后恢复", async () => {
      await page.goto(url);
      const now = page.getByRole("button", { name: "立即", exact: true });
      await now.waitFor();
      await now.evaluate((button) => {
        button.click();
        button.click();
      });
      const pending = page.getByRole("button", { name: "启动中", exact: true });
      await pending.waitFor();
      assert.equal(await pending.isDisabled(), true);
      assert.equal(await pending.getAttribute("aria-busy"), "true");
      assert.equal(await fixture("calls"), 1);
      await fixture("settle", false);
      await now.waitFor();
      assert.equal(await now.isEnabled(), true);
      assert.equal(await page.getByRole("alert").count(), 0);
    });
    await t.test("失败可见，原消息保留并可重试", async () => {
      await page.getByRole("button", { name: "立即", exact: true }).click();
      await fixture("settle", true);
      await page.getByRole("alert").waitFor();
      assert.match(await page.getByRole("alert").innerText(), /未能立即启动/);
      await page.getByRole("button", { name: "立即", exact: true }).click();
      assert.equal(await page.getByRole("alert").count(), 0);
      assert.equal(await fixture("calls"), 3);
      await fixture("settle", false);
      await page.getByRole("button", { name: "立即", exact: true }).waitFor();
    });
    await t.test("切换会话后迟到的失败不污染新会话", async () => {
      await page.getByRole("button", { name: "立即", exact: true }).click();
      await fixture("switchSession");
      await page.getByRole("button", { name: "立即", exact: true }).waitFor();
      await fixture("settle", true);
      assert.equal(await page.getByRole("alert").count(), 0);
      assert.equal(await page.getByRole("button", { name: "立即", exact: true }).isEnabled(), true);
    });
    await t.test("手机宽度失败说明不横向溢出", async () => {
      await page.setViewportSize({ width: 390, height: 800 });
      await page.getByRole("button", { name: "立即", exact: true }).click();
      await fixture("settle", true);
      await page.getByRole("alert").waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
      );
    });
    await t.test("桌面和手机按 ACK 原因显示反馈，保留队列消息并允许重试", async () => {
      const cases = [
        ["fault.command.sessionIdleTimeout", /当前任务仍在结束或清理资源/],
        ["guard.queuePromotionBusy", /另一条消息正在启动/],
        ["guard.queueItemReserved", /另一条消息正在启动/],
        ["restoreWarning", /排队消息的模型不可用/],
        ["stale", /会话状态已变化/],
        ["unknown", /未能立即启动，消息已保留/],
      ];
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 800 });
        for (const [reason, expected] of cases) {
          await page.getByRole("button", { name: "立即", exact: true }).click();
          await page.getByRole("button", { name: "启动中", exact: true }).waitFor();
          assert.equal(await page.getByRole("alert").count(), 0);
          await fixture("settle", true, reason);
          const alert = page.getByRole("alert");
          await alert.waitFor();
          assert.match(await alert.innerText(), expected);
          assert.equal(
            await page.locator('[data-queue-item-id="queued"][data-kind="sendText"]').count(),
            1,
          );
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
            true,
          );
        }
      }
    });
    await t.test("立即切换状态保留完整选型，完成后更新，手机上可阅读且不溢出", async () => {
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 800 });
        await fixture("showSwitch", "waitingSafeBoundary");
        const waiting = page.locator('[data-execution-switch-status="waitingSafeBoundary"]');
        await waiting.waitFor();
        const text = await waiting.innerText();
        assert.match(text, /正在切换：provider-a\/model-a/);
        assert.match(text, /provider-b\/model-b/);
        assert.match(text, /正在结束旧请求或等待工具完成/);
        assert.doesNotMatch(text, /等待安全切换/);
        assert.match(text, /推理强度/);
        assert.match(text, /速度：快速/);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          true,
        );
        const clipped = await waiting
          .locator("span")
          .evaluate(
            (span) => span.scrollWidth > span.clientWidth || span.scrollHeight > span.clientHeight,
          );
        assert.equal(clipped, false);
        await fixture("showSwitch", "active");
        const active = page.locator('[data-execution-switch-status="active"]');
        await active.waitFor();
        assert.match(await active.innerText(), /已切换/);
        await fixture("showSwitch", null);
        await active.waitFor({ state: "detached" });
      }
    });
    assert.deepEqual(errors, []);
  },
);
