import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve, extname, relative, isAbsolute } from "node:path";
import { chromium } from "playwright-core";
import { createServer as createViteServer } from "vite";
import { buildWebsite } from "../cfworker-remote/site/build.mjs";
import { createReleaseCatalog } from "../cfworker-remote/src/releaseCatalog.ts";

const root = resolve(import.meta.dirname, "..");
export const storageKey = "lcode:remote-pairing:device:v1";
export const grant = {
  roomId: "test-room-recovery-1",
  deviceId: "test-device-1",
  deviceCredential: "test-authorized-device-credential",
  grantedAt: 1,
};
const suffixes = [
  "win-x64.exe",
  "win-arm64.exe",
  "mac-x64.dmg",
  "mac-arm64.dmg",
  "mac-x64.zip",
  "mac-arm64.zip",
  "linux-x86_64.AppImage",
  "linux-arm64.AppImage",
  "linux-amd64.deb",
  "linux-arm64.deb",
  "linux-x86_64.rpm",
  "linux-aarch64.rpm",
  "linux-x64.pkg.tar.zst",
  "linux-aarch64.pkg.tar.zst",
];
export async function startWebsite(t) {
  const dir = await mkdtemp(resolve(tmpdir(), "lcode-website-"));
  const site = resolve(dir, "site");
  await buildWebsite(site);
  const { build } = createRequire(resolve(root, "cfworker-remote/package.json"))("esbuild");
  await build({
    entryPoints: [resolve(root, "packages/web/src/remote/rootRecoveryEntry.ts")],
    bundle: true,
    minify: true,
    format: "esm",
    platform: "browser",
    outfile: resolve(site, "assets/remote-entry.js"),
  });
  const vite = await createViteServer({
    root: resolve(root, "packages/web"),
    configFile: resolve(root, "packages/web/vite.config.ts"),
    server: { host: "127.0.0.1", port: 0, hmr: false },
    logLevel: "error",
  });
  await vite.listen();
  const viteOrigin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const state = { catalogMode: "normal", requests: [] };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    state.requests.push(url.pathname);
    try {
      if (url.pathname === "/api/v1/releases/catalog") {
        if (state.catalogMode === "failure") {
          response.writeHead(503);
          response.end("unavailable");
          return;
        }
        const catalog = createReleaseCatalog(
          [
            {
              tag_name: "v3.16.2",
              published_at: "2026-10-01T00:00:00Z",
              assets: suffixes.map((suffix) => ({
                name: `LCode-3.16.2-${suffix}`,
                size: 10485760,
              })),
            },
          ],
          origin,
          Date.now(),
        );
        if (state.catalogMode === "missing")
          catalog.installers = catalog.installers.filter(
            (item) => !(item.os === "win" && item.arch === "arm64"),
          );
        if (state.catalogMode === "stale") catalog.stale = true;
        if (state.catalogMode === "invalid")
          catalog.installers[0].downloadUrl = "https://untrusted.invalid/download";
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(catalog));
        return;
      }
      const pages = { "/": "index.html", "/download": "download.html", "/remote": "remote.html" };
      if (pages[url.pathname] || url.pathname.startsWith("/site/assets/")) {
        const file = pages[url.pathname]
          ? resolve(site, pages[url.pathname])
          : resolve(dir, `.${url.pathname}`);
        const withinSite = relative(site, file);
        if (withinSite.startsWith("..") || isAbsolute(withinSite))
          throw new Error("invalid static path");
        const data = await readFile(file);
        const type = {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".png": "image/png",
          ".svg": "image/svg+xml",
        }[extname(file)];
        response.writeHead(200, { "content-type": type, "cache-control": "no-store" });
        response.end(data);
        return;
      }
      // 同源代理 Vite 夹具：页面、存储与真实连接实现不变，仅网络端模拟 Worker。
      const target = url.pathname.startsWith("/p/")
        ? "/test/fixtures/mobile-pairing-reconnect.html"
        : request.url;
      const proxied = await fetch(`${viteOrigin}${target}`);
      response.writeHead(proxied.status, {
        "content-type": proxied.headers.get("content-type") ?? "text/plain",
      });
      response.end(Buffer.from(await proxied.arrayBuffer()));
    } catch {
      response.writeHead(404);
      response.end("not found");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  t.after(async () => {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await vite.close();
    // mkdtemp 的绝对目录属于本次测试；不接受用户路径或拼接后的递归删除目标。
    assert.equal(resolve(dir).startsWith(resolve(tmpdir(), "lcode-website-")), true);
    await rm(dir, { recursive: true, force: true });
  });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.LCODE_TEST_BROWSER_PATH
      ? { executablePath: process.env.LCODE_TEST_BROWSER_PATH }
      : {}),
  });
  await mkdir(resolve(root, ".artifacts/project-website"), { recursive: true });
  return { browser, origin, state, screenshots: resolve(root, ".artifacts/project-website") };
}
export async function pairedContext(browser, options = {}) {
  const context = await browser.newContext({ locale: "zh-CN", ...options });
  context.setDefaultTimeout(10000);
  context.setDefaultNavigationTimeout(45000);
  const worker = { mode: "connected", dataCalls: 0, pairCalls: 0, sockets: [] };
  await context.addInitScript(() => {
    const now = Date.now.bind(Date);
    globalThis.__pairingClockOffset = 0;
    Date.now = () => now() + globalThis.__pairingClockOffset;
  });
  await context.routeWebSocket(/\/ws(?:\/pair)?\?/, (socket) => {
    const target = new URL(socket.url());
    if (target.pathname === "/ws/pair") {
      worker.pairCalls++;
      socket.close({ code: 4002, reason: "no pairing expected" });
      return;
    }
    worker.dataCalls++;
    if (worker.mode === "revoked") {
      socket.close({ code: 4002, reason: "device rejected" });
      return;
    }
    if (worker.mode === "missing") {
      socket.close({ code: 4004, reason: "room not found" });
      return;
    }
    if (worker.mode === "busy") {
      socket.close({ code: 4008, reason: "room busy" });
      return;
    }
    worker.sockets.push(socket);
    socket.onMessage((message) => {
      if (message === '{"type":"ping"}') socket.send('{"type":"pong"}');
    });
    socket.send(
      JSON.stringify({ type: "bridge.open", proto: 1, deviceId: grant.deviceId, resumed: true }),
    );
  });
  return { context, worker };
}
