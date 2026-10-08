import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOM = "test-room-recovery-1";
const CAPABILITY = "test-once-pairing-capability";
const CREDENTIAL = "test-authorized-device-credential";

async function startFixture(t) {
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
  let output = "";
  let browser;
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
  server.stdout.on("data", (data) => {
    output += data;
  });
  server.stderr.on("data", (data) => {
    output += data;
  });
  assert.ok(
    await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 45_000);
      const check = () => {
        if (stripVTControlCharacters(output).includes("Local:")) {
          clearTimeout(timer);
          resolve(true);
        }
      };
      server.stdout.on("data", check);
      server.once("exit", () => {
        clearTimeout(timer);
        resolve(false);
      });
      check();
    }),
    output,
  );
  browser = await chromium.launch({
    headless: true,
    ...(process.env.LCODE_TEST_BROWSER_PATH
      ? { executablePath: process.env.LCODE_TEST_BROWSER_PATH }
      : {}),
  });
  return {
    browser,
    url: `http://127.0.0.1:${port}/test/fixtures/mobile-pairing-reconnect.html?roomId=${ROOM}#c=${CAPABILITY}`,
  };
}

async function createWorkerContext(browser, viewport) {
  const context = await browser.newContext({ viewport, locale: "zh-CN" });
  const worker = {
    consumed: false,
    revoked: false,
    busy: false,
    holdBridge: false,
    pairCalls: 0,
    dataCalls: 0,
    sockets: [],
  };
  await context.addInitScript(() => {
    const originalNow = Date.now.bind(Date);
    globalThis.__pairingClockOffset = 0;
    Date.now = () => originalNow() + globalThis.__pairingClockOffset;
  });
  // 拦截真实浏览器 WebSocket；一次性 capability 与设备撤销仍在网络边界执行。
  await context.routeWebSocket(/\/ws(?:\/pair)?\?/, (socket) => {
    const target = new URL(socket.url());
    if (target.pathname === "/ws/pair") {
      worker.pairCalls += 1;
      if (worker.consumed || target.searchParams.get("auth") !== CAPABILITY) {
        socket.close({ code: 4002, reason: "capability consumed" });
        return;
      }
      worker.consumed = true;
      socket.send(
        JSON.stringify({
          type: "pairing.accepted",
          deviceId: "test-device-1",
          deviceCredential: CREDENTIAL,
        }),
      );
      return;
    }
    worker.dataCalls += 1;
    if (worker.revoked || target.searchParams.get("auth") !== CREDENTIAL) {
      socket.close({ code: 4002, reason: "device credential rejected" });
      return;
    }
    if (worker.busy) {
      socket.close({ code: 4008, reason: "room busy" });
      return;
    }
    worker.sockets.push(socket);
    socket.onMessage((message) => {
      if (message === '{"type":"ping"}') socket.send('{"type":"pong"}');
    });
    if (!worker.holdBridge)
      socket.send(
        JSON.stringify({
          type: "bridge.open",
          proto: 1,
          deviceId: "test-device-1",
          resumed: worker.dataCalls > 1,
        }),
      );
  });
  return { context, worker };
}

async function connected(page) {
  await page.getByTestId("mobile-pairing-connected").waitFor({ timeout: 20_000 });
}

test("手机远控：关闭页面、后台断连与网络重试不重放配对链接", { timeout: 240_000 }, async (t) => {
  const { browser, url } = await startFixture(t);
  for (const width of [390, 1280]) {
    await t.test(`${width}px：关闭标签页后重新打开原链接`, async () => {
      const { context, worker } = await createWorkerContext(browser, { width, height: 844 });
      try {
        let page = await context.newPage();
        await page.goto(url);
        await connected(page);
        await page.close();
        page = await context.newPage();
        await page.goto(url);
        await connected(page);
        assert.equal(worker.pairCalls, 1);
        assert.equal(worker.dataCalls, 2);
      } finally {
        await context.close();
      }
    });
  }
  await t.test("心跳断连后通过原设备凭据恢复，不重新确认", async () => {
    const { context, worker } = await createWorkerContext(browser, { width: 390, height: 844 });
    try {
      const page = await context.newPage();
      await page.goto(url);
      await connected(page);
      const reload = page.waitForEvent("load");
      worker.sockets.at(-1).close({ code: 4001, reason: "heartbeat timeout" });
      await reload;
      await connected(page);
      assert.equal(worker.pairCalls, 1);
      assert.equal(worker.dataCalls, 2);
    } finally {
      await context.close();
    }
  });
  await t.test("busy 重试截止只显示忙碌，不回退已消费 capability", async () => {
    const { context, worker } = await createWorkerContext(browser, { width: 390, height: 844 });
    try {
      const page = await context.newPage();
      await page.goto(url);
      await connected(page);
      worker.busy = true;
      await page.reload();
      await page.waitForFunction(() => document.body.textContent.includes("接入工作区"));
      await page.evaluate(() => {
        globalThis.__pairingClockOffset += 100_000;
      });
      await page
        .getByText("该房间已有其他设备接入。", { exact: true })
        .waitFor({ timeout: 12_000 });
      assert.equal(worker.pairCalls, 1);
      assert.ok(await page.evaluate(() => localStorage.getItem("lcode:remote-pairing:device:v1")));
    } finally {
      await context.close();
    }
  });
  await t.test("已授权设备撤销后清理凭据，不能重放原链接恢复授权", async () => {
    const { context, worker } = await createWorkerContext(browser, { width: 390, height: 844 });
    try {
      const page = await context.newPage();
      await page.goto(url);
      await connected(page);
      worker.revoked = true;
      await page.reload();
      await page.getByText("配对凭据无效、已被使用或已过期。", { exact: true }).waitFor();
      assert.equal(worker.pairCalls, 1);
      assert.equal(
        await page.evaluate(() => localStorage.getItem("lcode:remote-pairing:device:v1")),
        null,
      );
    } finally {
      await context.close();
    }
  });
  await t.test("接管后的明确撤销立即清理持久凭据", async () => {
    const { context, worker } = await createWorkerContext(browser, { width: 390, height: 844 });
    try {
      const page = await context.newPage();
      await page.goto(url);
      await connected(page);
      worker.sockets.at(-1).close({ code: 4007, reason: "device revoked" });
      await page.waitForFunction(
        () => localStorage.getItem("lcode:remote-pairing:device:v1") === null,
      );
      assert.equal(worker.pairCalls, 1);
    } finally {
      await context.close();
    }
  });
  await t.test("停止房间保留设备授权，打开新房间后免重复确认", async () => {
    const { context, worker } = await createWorkerContext(browser, { width: 390, height: 844 });
    try {
      const page = await context.newPage();
      await page.goto(url);
      await connected(page);
      worker.sockets.at(-1).close({ code: 4007, reason: "room stopped" });
      await page.goto(url.replace(ROOM, "test-room-recovery-2"));
      await connected(page);
      assert.equal(worker.pairCalls, 1);
      assert.equal(
        await page.evaluate(
          () => JSON.parse(localStorage.getItem("lcode:remote-pairing:device:v1")).roomId,
        ),
        "test-room-recovery-2",
      );
    } finally {
      await context.close();
    }
  });
  await t.test("未接管的 bridge.open 超时不能触发整页重连", async () => {
    const { context, worker } = await createWorkerContext(browser, { width: 390, height: 844 });
    try {
      const page = await context.newPage();
      await page.goto(url);
      await connected(page);
      worker.holdBridge = true;
      await page.clock.install();
      await page.reload();
      await page.waitForFunction(() => document.body.textContent.includes("接入工作区"));
      await page.clock.fastForward(16_000);
      await page.getByText("建立数据通道超时。", { exact: true }).waitFor({ timeout: 10_000 });
      assert.equal(worker.pairCalls, 1);
      assert.equal(worker.dataCalls, 2);
    } finally {
      await context.close();
    }
  });
  for (const width of [390, 1280]) {
    await t.test(`${width}px：桌面等待重连面板不展示旧二维码，停止入口可用`, async () => {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        locale: "zh-CN",
      });
      try {
        const page = await context.newPage();
        await page.goto(url.replace(`?roomId=${ROOM}`, `?panel=1&roomId=${ROOM}`));
        await page.getByText("等待手机重新连接…", { exact: true }).waitFor();
        assert.equal(await page.getByTestId("remote-control-pairing-url").count(), 0);
        assert.equal(await page.getByText("配对出错", { exact: true }).count(), 0);
        await page.getByRole("button", { name: "停止", exact: true }).click();
        await page.getByTestId("pairing-stopped").waitFor();
      } finally {
        await context.close();
      }
    });
  }
});
