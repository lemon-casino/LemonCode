import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { providers } from "../cfworker-remote/site/content.mjs";
import { grant, storageKey, startWebsite, pairedContext } from "./project-website-browser.mjs";

test("官网与下载：真实页面、手机布局、目录降级和根入口恢复", { timeout: 240_000 }, async (t) => {
  const { browser, origin, state, screenshots } = await startWebsite(t);
  for (const width of [1280, 390]) {
    await t.test(`${width}px 无配对：官网、供应商、远程连接与下载可使用`, async () => {
      const { context, worker } = await pairedContext(browser, {
        viewport: { width, height: 844 },
      });
      const errors = [];
      try {
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(origin);
        await page
          .locator("[data-release-status]")
          .getByText("正式版", { exact: false })
          .waitFor({ timeout: 8000 })
          .catch(async () => {
            assert.fail(
              JSON.stringify({
                status: await page.locator("[data-release-status]").textContent(),
                errors,
                requests: state.requests.slice(-12),
              }),
            );
          });
        assert.equal(await page.locator("html[data-lcode-site]").count(), 1);
        assert.equal(worker.dataCalls, 0);
        assert.equal(worker.pairCalls, 0);
        const strip = page.locator(".provider-marquee");
        const track = strip.locator(".provider-track");
        assert.deepEqual(
          await strip
            .locator(".provider-group:not([aria-hidden]) .provider-name")
            .allTextContents(),
          providers.map((provider) => provider.name),
        );
        assert.equal(await strip.locator('.provider-group[aria-hidden="true"]').count(), 1);
        assert.equal(
          await page.locator(".provider-grid, .provider-featured, .product-figure").count(),
          0,
        );
        const icons = await strip
          .locator("img")
          .evaluateAll((images) => images.map((image) => image.getAttribute("src")));
        assert.equal(icons.length, 50);
        assert.ok(icons.every((src) => src.endsWith(".svg")));
        assert.equal(
          state.requests.some((path) => /provider-accounts/.test(path)),
          false,
        );
        await page.waitForFunction(() =>
          [...document.querySelectorAll('img:not([loading="lazy"])')].every(
            (image) => image.complete && image.naturalWidth > 0,
          ),
        );
        // 按实际位移检查从左向右；暂停、悬停和减少动画偏好都应停止移动。
        const previousX = await track.evaluate((element) => element.getBoundingClientRect().x);
        await page.waitForFunction(
          (x) => document.querySelector(".provider-track").getBoundingClientRect().x > x + 2,
          previousX,
        );
        await strip.getByRole("button", { name: "暂停滚动" }).click();
        assert.equal(
          await track.evaluate((element) => getComputedStyle(element).animationPlayState),
          "paused",
        );
        await strip.getByRole("button", { name: "继续滚动" }).click();
        await page.mouse.move(0, 0);
        await strip.locator(".provider-viewport").hover();
        assert.equal(
          await track.evaluate((element) => getComputedStyle(element).animationPlayState),
          "paused",
        );
        await page.mouse.move(0, 0);
        await strip.locator(".provider-viewport").focus();
        assert.equal(
          await track.evaluate((element) => getComputedStyle(element).animationPlayState),
          "paused",
        );
        await strip.locator(".provider-viewport").evaluate((element) => element.blur());
        await page.emulateMedia({ reducedMotion: "reduce" });
        assert.equal(
          await track.evaluate((element) => getComputedStyle(element).animationName),
          "none",
        );
        assert.equal(await strip.getByRole("button").isVisible(), false);
        assert.equal(await strip.locator('.provider-group[aria-hidden="true"]').isVisible(), false);
        assert.ok(
          await strip.locator(".provider-viewport").evaluate((element) => {
            element.scrollLeft = 200;
            return element.scrollLeft > 0;
          }),
        );
        await strip.locator(".provider-viewport").evaluate((element) => {
          element.scrollLeft = 0;
        });
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await strip.screenshot({ path: resolve(screenshots, `providers-${width}.png`) });
        await page.locator(".faq summary").first().click();
        assert.equal(await page.locator("dialog, [role=dialog]").count(), 0);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.screenshot({ path: resolve(screenshots, `home-${width}.png`), fullPage: true });
        await page
          .getByRole("navigation", { name: "主导航" })
          .getByRole("link", { name: "远程连接", exact: true })
          .click();
        for (const name of ["SSH", "WSL", "Docker"])
          assert.ok((await page.locator("main").textContent()).includes(name));
        await page
          .getByRole("navigation", { name: "主导航" })
          .getByRole("link", { name: "下载 LCode", exact: true })
          .click();
        await page.locator('[data-os="win"] [data-download-link][href]').waitFor();
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.screenshot({
          path: resolve(screenshots, `download-${width}.png`),
          fullPage: true,
        });
        await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await page.screenshot({
          path: resolve(screenshots, `download-dark-${width}.png`),
          fullPage: true,
        });
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });
  }
  await t.test("跨平台格式切换只生成该正式版本中真实资产的链接", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/download`);
      await page.locator('[data-os="win"] [data-download-link][href]').waitFor();
      for (const [os, formats] of [
        ["win", ["exe"]],
        ["mac", ["dmg", "zip"]],
        ["linux", ["AppImage", "deb", "rpm", "pkg.tar.zst"]],
      ]) {
        const card = page.locator(`[data-os="${os}"]`);
        for (const arch of ["x64", "arm64"]) {
          await card.locator(`input[value="${arch}"]`).check();
          for (const format of formats) {
            await card.locator("select").selectOption(format);
            const link = card.locator("[data-download-link]");
            assert.ok(
              (await link.getAttribute("href")).startsWith(
                `${origin}/api/v1/releases/download/v3.16.2/LCode-3.16.2-${os}-`,
              ),
            );
            assert.ok((await link.textContent()).includes(arch === "arm64" ? "ARM64" : "x64"));
            assert.ok((await link.textContent()).includes(format));
          }
        }
      }
      state.catalogMode = "missing";
      await page.reload();
      await page.locator('[data-os="win"] [data-download-link][href]').waitFor();
      await page.locator('[data-os="win"] input[value="arm64"]').check();
      assert.equal(
        await page.locator('[data-os="win"] [data-download-link]').getAttribute("href"),
        null,
      );
      for (const mode of ["failure", "invalid"]) {
        state.catalogMode = mode;
        await page.reload();
        await page.getByText("暂时无法获取发布信息。", { exact: false }).waitFor();
        assert.equal(await page.locator("[data-download-link][href]").count(), 0);
        assert.ok(
          (await page.locator("[data-release-link]").getAttribute("href")).endsWith("/releases"),
        );
      }
      state.catalogMode = "stale";
      await page.locator("[data-retry-catalog]").click();
      await page.getByText("最近获取的发布信息", { exact: false }).waitFor();
      assert.equal(await page.locator("[data-download-link][href]").count(), 3);
      state.catalogMode = "normal";
      await page.locator("[data-retry-catalog]").click();
      await page.getByText("正式版", { exact: false }).waitFor();
    } finally {
      state.catalogMode = "normal";
      await context.close();
    }
  });
  await t.test("无 JavaScript 仍可阅读官网并进入发行页，损坏记录保持官网", async () => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/download`);
      await page.locator("noscript").getByRole("link", { name: "GitHub Releases" }).waitFor();
      assert.equal(await page.locator("[data-download-link][href]").count(), 0);
    } finally {
      await context.close();
    }
    const { context: corrupted, worker } = await pairedContext(browser);
    try {
      const page = await corrupted.newPage();
      await page.goto(`${origin}/?view=site`);
      await page.evaluate((key) => localStorage.setItem(key, "broken"), storageKey);
      await page.goto(origin);
      await page.locator(".hero h1").waitFor();
      assert.equal(worker.dataCalls, 0);
    } finally {
      await corrupted.close();
    }
  });
  for (const width of [390, 1280]) {
    await t.test(`${width}px 已配对根路径、重新打开页面与显式官网`, async () => {
      const { context, worker } = await pairedContext(browser, {
        viewport: { width, height: 844 },
      });
      try {
        let page = await context.newPage();
        await page.goto(`${origin}/?view=site`);
        await page.evaluate(({ key, grant }) => localStorage.setItem(key, JSON.stringify(grant)), {
          key: storageKey,
          grant,
        });
        const stored = await page.evaluate((key) => localStorage.getItem(key), storageKey);
        for (const path of ["/?view=site", "/download", "/remote"]) {
          await page.goto(`${origin}${path}`);
          await page.locator("html[data-lcode-site]").waitFor();
          assert.equal(worker.dataCalls, 0);
          assert.equal(await page.evaluate((key) => localStorage.getItem(key), storageKey), stored);
        }
        await page.goto(origin);
        await page.getByTestId("mobile-pairing-connected").waitFor({ timeout: 30000 });
        assert.equal(new URL(page.url()).pathname, `/p/${grant.roomId}`);
        assert.equal(new URL(page.url()).search, "");
        await page.close();
        page = await context.newPage();
        await page.goto(origin);
        await page.getByTestId("mobile-pairing-connected").waitFor();
        assert.equal(worker.dataCalls, 2);
        assert.equal(worker.pairCalls, 0);
        worker.mode = "revoked";
        await page.goto(origin);
        await page.waitForURL(`${origin}/?view=site&remote=unpaired`);
        await page.locator("[data-remote-notice]").waitFor();
        assert.equal(await page.evaluate((key) => localStorage.getItem(key), storageKey), null);
        await page.reload();
        assert.equal(worker.dataCalls, 3);
        assert.equal(worker.pairCalls, 0);
      } finally {
        await context.close();
      }
    });
  }
  await t.test("根恢复房间缺失/busy 截止保留授权，提供页内重试且不循环", async () => {
    const { context, worker } = await pairedContext(browser);
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/?view=site`);
      await page.evaluate(({ key, grant }) => localStorage.setItem(key, JSON.stringify(grant)), {
        key: storageKey,
        grant,
      });
      worker.mode = "missing";
      await page.goto(origin);
      await page.waitForURL(`${origin}/?view=site&remote=unavailable`);
      assert.deepEqual(
        await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey),
        grant,
      );
      const calls = worker.dataCalls;
      await page.reload();
      assert.equal(worker.dataCalls, calls);
      worker.mode = "busy";
      await page.locator("[data-remote-retry]").click();
      await page.waitForFunction(() => document.body.textContent.includes("接入工作区"));
      await page.evaluate(() => {
        globalThis.__pairingClockOffset += 100000;
      });
      await page.waitForURL(`${origin}/?view=site&remote=unavailable`, { timeout: 15000 });
      assert.deepEqual(
        await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey),
        grant,
      );
      assert.equal(worker.pairCalls, 0);
    } finally {
      await context.close();
    }
  });
  assert.equal(
    state.requests.some((path) => path === "/site/assets/remote-entry.js"),
    true,
  );
});
