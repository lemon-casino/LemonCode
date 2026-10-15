import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright-core";
import {
  verifyTokenUsageInteractions,
  verifyStatusBarPlacement,
  verifyNewConversationStatusBar,
  verifyCompactFooter,
} from "./token-usage-statusbar-interaction-cases.mjs";

test(
  "原生 Token 状态栏：三位置、设置保存、七主题、活动速度和发送/停止对齐",
  { timeout: 180_000 },
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
    let browser;
    let page;
    let output = "";
    server.stdout.on("data", (chunk) => {
      output += chunk;
    });
    server.stderr.on("data", (chunk) => {
      output += chunk;
    });
    t.after(async () => {
      if (page && process.env.LCODE_TEST_SCREENSHOT_DIR) {
        await mkdir(process.env.LCODE_TEST_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: `${process.env.LCODE_TEST_SCREENSHOT_DIR}/last-state.png` });
      }
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
    assert.ok(
      await new Promise((resolve) => {
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
      }),
      output,
    );
    browser = await chromium.launch({
      headless: true,
      ...(process.env.LCODE_TEST_BROWSER_PATH
        ? { executablePath: process.env.LCODE_TEST_BROWSER_PATH }
        : {}),
    });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
      console.error(error.stack);
    });
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/token-usage-statusbar.html`);
    const composer = page.getByTestId("production-composer");
    const bar = composer.getByTestId("token-usage-statusbar");
    await bar.waitFor();
    const scene = (name) => page.evaluate((name) => globalThis.__tokenFixture.scenario(name), name);
    const enabled = async () =>
      page.getByTestId("token-usage-statusbar-toggle-enabled").isEnabled();
    const showSettings = async () => {
      await page.keyboard.press("Escape");
      await page.mouse.move(5, 5);
      await page.getByRole("button", { name: "Settings view", exact: true }).click();
    };
    const showConversation = () =>
      page.getByRole("button", { name: "Conversation view", exact: true }).click();
    const toggle = async (key) => {
      await showSettings();
      const control = page.getByTestId(`token-usage-statusbar-toggle-${key}`);
      const checked = await control.getAttribute("aria-checked");
      await control.click();
      await page.waitForFunction(
        ({ key, checked }) => {
          const element = document.querySelector(
            `[data-testid="token-usage-statusbar-toggle-${key}"]`,
          );
          return element.getAttribute("aria-checked") !== checked && !element.disabled;
        },
        { key, checked },
      );
      await showConversation();
    };
    await page.waitForFunction(
      () =>
        !document.querySelector('[data-testid="token-usage-statusbar-toggle-enabled"]').disabled,
    );
    assert.ok(await enabled());
    assert.ok(
      await page.evaluate(() =>
        globalThis.__tokenFixture.nav
          .find((group) => group.id === "basics")
          .sections.includes("tokenUsageStatusBar"),
      ),
    );
    assert.equal(await composer.getByRole("switch").count(), 0);
    assert.match(await bar.innerText(), /均 50\/s/);
    assert.match(await bar.innerText(), /会话/);
    assert.equal(
      await composer
        .locator('[data-composer-config-actions] [data-testid="token-usage-session"]')
        .count(),
      0,
    );
    await verifyTokenUsageInteractions(page, composer, bar);

    await scene("pending");
    await composer.getByTestId("v4-stop").waitFor();
    await scene("live");
    await bar.locator('[data-speed-kind="live"]').waitFor();
    assert.match(await bar.innerText(), /20\/s/);
    const waves = bar.locator(".token-usage-wave");
    assert.notEqual(
      await waves.first().evaluate((element) => getComputedStyle(element).animationName),
      "none",
    );
    await toggle("animations");
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="production-composer"] [data-animated="false"]'),
    );
    assert.equal(
      await waves.first().evaluate((element) => getComputedStyle(element).animationName),
      "none",
    );
    await toggle("animations");
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(
      await waves.first().evaluate((element) => getComputedStyle(element).animationName),
      "none",
    );
    await page.emulateMedia({ reducedMotion: "no-preference" });

    const choosePosition = async (position) => {
      await showSettings();
      await page.getByTestId("token-usage-statusbar-position").scrollIntoViewIfNeeded();
      await page.getByTestId("token-usage-statusbar-position").click();
      await page.getByRole("listbox").waitFor();
      const names = {
        inside: "输入框内部底部",
        below: "输入框下方",
        above: "输入框上方",
      };
      await page.getByRole("option", { name: names[position], exact: true }).click();
      await showConversation();
      await composer
        .locator(
          `[data-composer-statusbar-slot="${position}"] [data-testid="token-usage-statusbar"]`,
        )
        .waitFor();
    };
    await composer.getByTestId("v4-composer-input").evaluate((element) => {
      globalThis.__originalEditor = element;
    });
    for (const position of ["below", "above", "inside"]) {
      await choosePosition(position);
      await verifyStatusBarPlacement(composer, position);
      if (position === "above") await verifyNewConversationStatusBar(page, composer, bar);
      assert.ok(
        await composer
          .getByTestId("v4-composer-input")
          .evaluate((element) => element === globalThis.__originalEditor),
      );
    }
    await verifyCompactFooter(bar);

    const themes = [
      "zai-light",
      "zai-dark",
      "sepia-light",
      "midnight-blue",
      "forest-dark",
      "cinnabar",
      "inkpurple",
    ];
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of themes) {
        await page.evaluate((theme) => globalThis.__tokenFixture.theme(theme), theme);
        await choosePosition("above");
        await verifyStatusBarPlacement(composer, "above");
        if (process.env.LCODE_TEST_SCREENSHOT_DIR && width === 1280) {
          await composer.screenshot({
            path: `${process.env.LCODE_TEST_SCREENSHOT_DIR}/composer-above-${theme}.png`,
          });
        }
        await choosePosition("inside");
        for (const scenario of ["average", "pending"]) {
          await scene(scenario);
          const action = composer.getByTestId(
            scenario === "average" ? "v4-composer-send" : "v4-stop",
          );
          await action.waitFor();
          const centers = await composer.evaluate((element) => {
            const rect = (selector) => element.querySelector(selector).getBoundingClientRect();
            const speed = rect('[data-testid="chat-model-speed-trigger"]');
            const action = rect("[data-composer-trailing-actions] button");
            return {
              speed: speed.y + speed.height / 2,
              action: action.y + action.height / 2,
              width: document.documentElement.scrollWidth,
              viewport: innerWidth,
            };
          });
          assert.ok(
            Math.abs(centers.speed - centers.action) <= 1,
            JSON.stringify({ width, theme, scenario, centers }),
          );
          assert.ok(centers.width <= centers.viewport + 1);
        }
        if (width === 1280) {
          const iconColors = await bar
            .locator(".token-usage-metric-icon")
            .evaluateAll((elements) => elements.map((element) => getComputedStyle(element).color));
          assert.ok(new Set(iconColors).size >= 4, JSON.stringify({ theme, iconColors }));
          const accents = [];
          for (const metric of ["session", "cache"]) {
            await bar.getByTestId(`token-usage-${metric}`).click();
            const panel = page.getByTestId(`token-usage-detail-${metric}`);
            await panel.waitFor();
            const colors = await panel.evaluate((element) => {
              const context = document
                .createElement("canvas")
                .getContext("2d", { willReadFrequently: true });
              const rgba = (color) => {
                context.clearRect(0, 0, 1, 1);
                context.fillStyle = color;
                context.fillRect(0, 0, 1, 1);
                return [...context.getImageData(0, 0, 1, 1).data];
              };
              const luminance = (channels) =>
                channels
                  .slice(0, 3)
                  .map((value) => {
                    const unit = value / 255;
                    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
                  })
                  .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
              const labels = [...element.querySelectorAll(".token-usage-detail-label")];
              const contrast = labels.map((row) => {
                let background = row;
                while (background && rgba(getComputedStyle(background).backgroundColor)[3] < 255)
                  background = background.parentElement;
                const foregroundLight = luminance(rgba(getComputedStyle(row).color));
                const backgroundLight = luminance(
                  rgba(getComputedStyle(background).backgroundColor),
                );
                return (
                  (Math.max(foregroundLight, backgroundLight) + 0.05) /
                  (Math.min(foregroundLight, backgroundLight) + 0.05)
                );
              });
              return {
                accent: getComputedStyle(element).borderTopColor,
                rows: labels.map((row) => getComputedStyle(row).color),
                contrast,
              };
            });
            const iconColor = await bar
              .getByTestId(`token-usage-${metric}`)
              .locator(".token-usage-metric-icon")
              .evaluate((element) => getComputedStyle(element).color);
            assert.equal(colors.accent, iconColor);
            assert.ok(
              colors.contrast.every((ratio) => ratio >= 4.5),
              JSON.stringify({ theme, metric, contrast: colors.contrast }),
            );
            if (metric === "session")
              assert.ok(new Set(colors.rows).size >= 3, JSON.stringify(colors));
            accents.push(colors.accent);
            if (
              process.env.LCODE_TEST_SCREENSHOT_DIR &&
              metric === "session" &&
              ["zai-light", "zai-dark"].includes(theme)
            ) {
              await panel.screenshot({
                path: `${process.env.LCODE_TEST_SCREENSHOT_DIR}/detail-${theme}.png`,
              });
            }
            await page.keyboard.press("Escape");
            await panel.waitFor({ state: "hidden" });
          }
          assert.equal(new Set(accents).size, 2);
        }
      }
      for (const locale of ["zh-CN", "en-US"]) {
        await page.evaluate((locale) => globalThis.__tokenFixture.locale(locale), locale);
        await bar.getByTestId("token-usage-cache").click();
        const cacheDetail = page.getByTestId("token-usage-detail-cache");
        await cacheDetail.waitFor();
        await cacheDetail.evaluate(async (element) => {
          await Promise.all(element.getAnimations().map((animation) => animation.finished));
        });
        const bounds = await cacheDetail.boundingBox();
        assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
        await page.keyboard.press("Escape");
        await cacheDetail.waitFor({ state: "hidden" });
      }
      await page.evaluate(() => globalThis.__tokenFixture.locale("zh-CN"));
      if (process.env.LCODE_TEST_SCREENSHOT_DIR) {
        await mkdir(process.env.LCODE_TEST_SCREENSHOT_DIR, { recursive: true });
        await composer.screenshot({
          path: `${process.env.LCODE_TEST_SCREENSHOT_DIR}/token-statusbar-${width}.png`,
        });
      }
    }
    await scene("other");
    await page.waitForFunction(
      () =>
        !document.querySelector(
          '[data-testid="production-composer"] [data-testid="session-output-speed"]',
        ),
    );
    assert.equal(await bar.getByTestId("token-usage-request").count(), 0);
    await scene("average");
    await toggle("cache");
    await page.waitForFunction(
      () =>
        !document.querySelector(
          '[data-testid="production-composer"] [data-testid="token-usage-cache"]',
        ),
    );
    await toggle("enabled");
    await bar.waitFor({ state: "detached" });
    assert.ok(await page.getByTestId("token-usage-statusbar-toggle-speed").isDisabled());
    assert.equal(
      (await composer
        .locator('[data-composer-config-actions] [data-chat-toolbar-popover-trigger="true"]')
        .count()) > 0,
      true,
    );
    await toggle("enabled");
    await choosePosition("above");
    await page.reload();
    await composer
      .locator('[data-composer-statusbar-slot="above"] [data-testid="token-usage-statusbar"]')
      .waitFor();
    await verifyStatusBarPlacement(composer, "above");
    assert.equal(await bar.getByTestId("token-usage-cache").count(), 0);

    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      const phone = await mobile.newPage();
      phone.on("pageerror", (error) => errors.push(error.message));
      await phone.goto(`http://127.0.0.1:${port}/test/fixtures/token-usage-statusbar.html`);
      await phone.getByTestId("production-composer").getByTestId("token-usage-session").tap();
      await phone.getByTestId("token-usage-detail-session").waitFor();
      assert.match(await phone.getByTestId("token-usage-detail-session").innerText(), /420,000/);
    } finally {
      await mobile.close();
    }
    assert.deepEqual(errors, []);
  },
);
