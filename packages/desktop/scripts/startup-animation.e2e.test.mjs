import { runWallpaperTests } from "./startup-wallpaper.e2e.mjs";
import { runStartupSceneColdTest, runStartupSceneEditorTest } from "./startup-scene.e2e.mjs";
import { runStartupSceneResourceTests } from "./startup-scene-resources.e2e.mjs";
import { runStartupWelcomeTests, runCustomStartupEditorTest } from "./startup-welcome.e2e.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { createServer, build, preview } from "vite";
import { _electron, chromium } from "playwright-core";
import tailwindcss from "@tailwindcss/vite";
import { startupMediaPlugin } from "./startupMediaPlugin.ts";
import { startupEntryPlugins } from "./startupEntryPlugin.ts";
import {
  assertStartupMediaPackaging,
  assertPackagedStartupMedia,
} from "./startup-media-packaging.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");
const artifacts = resolve(desktopRoot, ".e2e-artifacts/startup-animation");
// 只替换业务依赖；真实 index.html、播放器、CSS、媒体服务与首窗快照契约均直接取源码。
const fixture = `
import { notifyStartupShellReady, notifyStartupSurface, previewStartupAnimation } from './startup/bridge.js';
const root=document.getElementById('root');
root.innerHTML='<main><p id="status">Preparing project</p><textarea aria-label="Project input" disabled></textarea></main>';
window.projectShortcutCount=0;
window.addEventListener('keydown',event=>{if(event.ctrlKey&&event.key==='Enter')window.projectShortcutCount++;});
window.startupFixture={
 ready(){root.querySelector('textarea').disabled=false;document.getElementById('status').textContent='Project ready';notifyStartupSurface('ready');},
 attention(){const message=document.createElement('div');message.role='alert';message.textContent='Retry startup';root.append(message);},
 preview:previewStartupAnimation
};
notifyStartupShellReady();
if(new URLSearchParams(location.search).get('ready')==='1')window.startupFixture.ready();
document.addEventListener('lcode-startup-finished',event=>window.startupResult=event.detail);
`;

test(
  "real desktop startup shell: decode, readiness, skip, reload, errors and file resources",
  { timeout: 240_000 },
  async (t) => {
    const hasMedia = process.env.LCODE_STARTUP_SMOKE_ONLY !== "1";
    let actualMediaDecoded = false;
    await mkdir(artifacts, { recursive: true });
    const userData = await mkdtemp(resolve(artifacts, "user-data-"));
    const mainEntry = resolve(desktopRoot, "src/renderer/src/main.tsx").replaceAll("\\", "/");
    const fixturePlugin = {
      name: "startup-business-fixture",
      enforce: "pre",
      load(id) {
        if (id.replaceAll("\\", "/") === mainEntry)
          return (
            fixture +
            `\nif(new URLSearchParams(location.search).get('settings')==='1') import('/@fs/${resolve(desktopRoot, "scripts/startup-settings.fixture.tsx").replaceAll("\\", "/")}');` +
            `\nif(new URLSearchParams(location.search).get('welcome')==='1') import('/@fs/${resolve(desktopRoot, "scripts/startup-welcome.fixture.tsx").replaceAll("\\", "/")}');`
          );
      },
    };
    const common = {
      configFile: false,
      // 回归使用独立依赖预构建缓存，避免和本机开发或生产构建互相覆盖。
      cacheDir: resolve(userData, "vite-cache"),
      logLevel: "warn",
      root: resolve(desktopRoot, "src/renderer"),
      base: "./",
      optimizeDeps: {
        noDiscovery: true,
        include: [
          "zod",
          "react",
          "react/jsx-runtime",
          "react/jsx-dev-runtime",
          "react-dom/client",
          "radix-ui",
        ],
      },
      resolve: { alias: { "@": resolve(desktopRoot, "../ui/src") } },
      esbuild: { jsx: "automatic" },
      plugins: [
        ...startupEntryPlugins(desktopRoot),
        startupMediaPlugin(desktopRoot),
        tailwindcss(),
        fixturePlugin,
      ],
    };
    const server = await createServer({ ...common, server: { host: "127.0.0.1", port: 0 } });
    await server.listen();
    t.after(() => server.close());
    const origin = server.resolvedUrls.local[0];
    const hostPath = resolve(artifacts, "electron.cjs");
    await writeFile(
      hostPath,
      `const {app,BrowserWindow}=require('electron');const option=name=>process.argv.find(arg=>arg.startsWith(name+'=')).slice(name.length+1);app.setPath('userData',option('--startup-user-data'));app.whenReady().then(()=>{const w=new BrowserWindow({width:1200,height:800,frame:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});w.loadURL(option('--startup-url'));});app.on('window-all-closed',()=>app.quit());`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const native = process.env.LCODE_STARTUP_ELECTRON_E2E !== "0";
    const electron = native
      ? await _electron.launch({
          executablePath: createRequire(import.meta.url)("electron"),
          args: [hostPath, `--startup-url=${origin}`, `--startup-user-data=${userData}`],
          env,
        })
      : undefined;
    const browser = !native ? await chromium.launch({ headless: true }) : undefined;
    t.after(() => electron?.close() ?? browser?.close());
    const page = electron
      ? await electron.firstWindow()
      : await browser.newPage({ viewport: { width: 1200, height: 800 } });
    page.setDefaultTimeout(15_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const navigate = async (mode, ready = false, preset = "baili", template = {}) => {
      const query = new URLSearchParams({
        startupAnimation: JSON.stringify({
          enabled: true,
          launchId: crypto.randomUUID(),
          settings: { mode, volume: 0, preset, ...template },
        }),
        ready: ready ? "1" : "0",
        locale: "zh-CN",
      });
      await page.goto(`${origin}?${query}`);
      await page.waitForFunction(() => Boolean(window.startupFixture));
    };
    await t.test(
      "Esc reveals pending project without admitting input",
      { skip: !hasMedia },
      async () => {
        await navigate("cinematic");
        await page.waitForFunction(() => document.querySelector("video")?.currentTime > 0.1);
        await page.keyboard.press("Control+Enter");
        assert.equal(await page.evaluate(() => window.projectShortcutCount), 0);
        assert.equal(
          await page.evaluate(() => document.documentElement.clientWidth === window.innerWidth),
          true,
        );
        await page.screenshot({ path: resolve(artifacts, "baili-playing.png") });
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("#loading").count(), 0);
        assert.equal(await page.getByRole("textbox").isDisabled(), true);
        await page.evaluate(() => window.startupFixture.ready());
        await page.getByRole("textbox").fill("project input after skip");
        await page.keyboard.press("Control+Enter");
        assert.equal(await page.evaluate(() => window.projectShortcutCount), 1);
      },
    );
    await t.test("simple and off modes never wait for the complete video", async () => {
      await navigate("simple", true);
      await page.waitForFunction(() => !document.getElementById("loading"));
      assert.equal(await page.locator("video").count(), 0);
      await navigate("off", true);
      await page.getByRole("textbox").fill("animation disabled");
      assert.equal(await page.locator("#loading").count(), 0);
    });
    await t.test(
      "actual video holds, resumes on ready and releases decoder",
      { skip: !hasMedia },
      async () => {
        await navigate("cinematic");
        await page.waitForFunction(
          () => document.querySelector("#loading")?.dataset.startupPhase === "hold",
          null,
          { timeout: 25_000 },
        );
        assert.equal(await page.locator("video").evaluate((video) => video.paused), true);
        await page.screenshot({ path: resolve(artifacts, "baili-hold.png") });
        assert.equal(await page.getByRole("textbox").isDisabled(), true);
        await page.evaluate(() => window.startupFixture.ready());
        await page.waitForFunction(() => !document.getElementById("loading"));
        assert.equal(await page.locator("video").count(), 0);
        await page.getByRole("textbox").fill("real project after animation");
        actualMediaDecoded = true;
        await page.screenshot({ path: resolve(artifacts, "project-ready.png") });
      },
    );
    await t.test(
      "removed startup preference uses official animation without bypassing readiness",
      async () => {
        await navigate("cinematic", false, "dragon");
        assert.equal(await page.locator("video").count(), 0);
        assert.equal(await page.getByRole("textbox").isDisabled(), true);
        await page.evaluate(() => window.startupFixture.ready());
        await page.waitForFunction(() => !document.getElementById("loading"));
        await page.getByRole("textbox").fill("legacy preference recovered");
      },
    );
    await t.test("attention, reduced motion and reload never wait for video", async () => {
      await navigate("cinematic");
      await page.evaluate(() => window.startupFixture.attention());
      await page.getByRole("alert").waitFor({ state: "visible" });
      assert.equal(await page.locator("#loading").count(), 0);
      await navigate("cinematic");
      await page.evaluate(() => {
        const dialog = document.createElement("div");
        dialog.role = "dialog";
        dialog.innerHTML = '<button id="confirm-startup">Confirm project</button>';
        document.body.append(dialog);
        document.getElementById("confirm-startup").focus();
      });
      await page.waitForFunction(() => !document.getElementById("loading"));
      assert.equal(await page.evaluate(() => document.activeElement?.id), "confirm-startup");
      await navigate("cinematic", true);
      await page.reload();
      await page.waitForFunction(() => !document.getElementById("loading"));
      assert.equal(await page.locator("video").count(), 0);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await navigate("cinematic", true);
      assert.equal(await page.locator("video").count(), 0);
      await page.emulateMedia({ reducedMotion: "no-preference" });
    });
    await t.test(
      "broken media, preview skip button, and mobile entry remain usable",
      { skip: !hasMedia },
      async () => {
        await page.route("**/startup-media/baili.mp4", (route) => route.abort());
        await navigate("cinematic", true);
        await page.waitForFunction(() => !document.getElementById("loading"));
        await page.unroute("**/startup-media/baili.mp4");
        await page.evaluate(() =>
          window.startupFixture.preview({ mode: "cinematic", volume: 0, preset: "baili" }),
        );
        await page.getByRole("button", { name: "跳过动画 · Esc" }).click();
        assert.equal(await page.locator("video").count(), 0);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${origin}?ready=1`);
        await page.getByRole("textbox").fill("mobile project directly");
        assert.equal(await page.locator("video").count(), 0);
      },
    );
    await runStartupSceneColdTest({ t, page, navigate, artifacts });
    await t.test(
      "ordinary production build includes complete media and plays from actual ASAR",
      async () => {
        const stage = resolve(artifacts, "packaged-stage");
        const outDir = resolve(stage, "out/renderer");
        await build({
          ...common,
          publicDir: false,
          plugins: [
            ...startupEntryPlugins(desktopRoot),
            startupMediaPlugin(desktopRoot),
            tailwindcss(),
            fixturePlugin,
          ],
          build: {
            outDir,
            emptyOutDir: true,
            rollupOptions: { input: resolve(desktopRoot, "src/renderer/index.html") },
          },
        });
        await assertStartupMediaPackaging(desktopRoot, outDir);
        for (const name of ["baili.mp4", "baili-wallpaper.mp4"]) {
          assert.ok((await readFile(resolve(outDir, "startup-media", name))).length > 0);
        }
        const { createPackage } = createRequire(import.meta.url)("@electron/asar");
        const archive = resolve(artifacts, "packaged.asar");
        await createPackage(stage, archive);
        await assertPackagedStartupMedia(desktopRoot, archive);
        const query = {
          startupAnimation: JSON.stringify({
            enabled: true,
            launchId: crypto.randomUUID(),
            settings: { mode: "cinematic", volume: 0, preset: "baili" },
          }),
          ready: "1",
        };
        if (!electron || !hasMedia) return;
        await electron.evaluate(
          async ({ BrowserWindow }, { path, query }) => {
            await BrowserWindow.getAllWindows()[0].loadFile(path, { query });
          },
          { path: resolve(archive, "out/renderer/index.html"), query },
        );
        await page.waitForFunction(() => document.querySelector("video")?.currentTime > 0.1);
        await page.keyboard.press("Escape");
        await page.getByRole("textbox").fill("packaged relative resources work");
      },
    );
    await t.test(
      "single startup selector persists choices and volume without playback mode or wallpaper preview",
      async () => {
        await page.setViewportSize({ width: 1200, height: 800 });
        if (electron) {
          await electron.evaluate(
            async ({ BrowserWindow }, path) =>
              BrowserWindow.getAllWindows()[0].loadFile(path, {
                query: { ready: "1", settings: "1", locale: "zh-CN" },
              }),
            resolve(artifacts, "packaged.asar/out/renderer/index.html"),
          );
        } else {
          const staticServer = await preview({
            configFile: false,
            root: desktopRoot,
            build: { outDir: resolve(artifacts, "packaged-stage/out/renderer") },
            preview: { host: "127.0.0.1", port: 0 },
          });
          t.after(() => new Promise((resolve) => staticServer.httpServer.close(resolve)));
          await page.goto(`${staticServer.resolvedUrls.local[0]}?ready=1&settings=1&locale=zh-CN`);
        }
        const animation = page.getByRole("combobox", { name: "启动动画", exact: true });
        await animation.waitFor();
        assert.equal(await page.getByRole("combobox", { name: "播放方式" }).count(), 0);
        assert.equal(await page.getByRole("combobox", { name: "动画预设" }).count(), 0);
        assert.equal(await page.getByText("项目背景预览", { exact: true }).count(), 0);
        await animation.click();
        assert.equal(await page.getByRole("option", { name: "龙娘", exact: true }).count(), 0);
        assert.equal(await page.getByRole("option").count(), 5);
        assert.equal(await page.getByRole("option", { name: "原始", exact: true }).count(), 1);
        assert.equal(await page.getByRole("option", { name: "爱弥斯", exact: true }).count(), 1);
        assert.equal(await page.getByRole("option", { name: "官方动画", exact: true }).count(), 0);
        assert.equal(
          await page.getByRole("option", { name: "爱弥斯（可编辑）", exact: true }).count(),
          0,
        );
        await page.getByRole("option", { name: "关闭", exact: true }).click();
        await page.getByRole("button", { name: "预览动画", exact: true }).waitFor();
        await animation.click();
        await page.getByRole("option", { name: hasMedia ? "白璃" : "原始", exact: true }).click();
        const volume = page.getByRole("combobox", { name: "视频音量" });
        if (hasMedia) {
          await volume.click();
          await page.getByRole("option", { name: "25%", exact: true }).click();
        }
        await page.reload();
        await animation.waitFor();
        assert.match(await animation.innerText(), hasMedia ? /白璃/ : /原始/);
        if (hasMedia) assert.match(await volume.innerText(), /25%/);
        await page.getByRole("button", { name: "预览动画", exact: true }).click();
        if (hasMedia)
          await page.waitForFunction(() => document.querySelector("video")?.currentTime > 0.1);
        else await page.getByRole("button", { name: "跳过动画 · Esc" }).waitFor();
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("video").count(), 0);
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(
          await page
            .locator("[data-testid=startup-animation-settings]")
            .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
          true,
        );
        await page.screenshot({ path: resolve(artifacts, "settings-mobile-width.png") });
        await page.setViewportSize({ width: 1200, height: 800 });
        await page.screenshot({ path: resolve(artifacts, "settings.png") });
      },
    );
    await runStartupSceneEditorTest({ t, page, artifacts });
    await runStartupSceneResourceTests({ t, page, navigate, artifacts });
    await runCustomStartupEditorTest({ t, page, artifacts });
    await runWallpaperTests({ t, page, hasMedia, artifacts });
    if (hasMedia) await runStartupWelcomeTests({ t, page, origin, artifacts });
    assert.deepEqual(errors, []);
    await writeFile(
      resolve(
        artifacts,
        `${native ? "electron" : "browser"}${hasMedia ? "" : "-smoke"}-result.json`,
      ),
      JSON.stringify(
        {
          platform: process.platform,
          architecture: process.arch,
          nativeElectron: native,
          actualMediaDecoded,
          pageErrors: errors,
          scope: "real startup shell with isolated business fixture",
        },
        null,
        2,
      ),
    );
  },
);
