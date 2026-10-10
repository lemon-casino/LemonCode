import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { chromium } from "playwright-core";
import { runThemeQualityInteractionCases } from "./theme-quality-interaction-cases.mjs";
import { runWelcomeLayoutQualityCases } from "./welcome-layout-quality-cases.mjs";

const themes = [
  ["zai-dark", "暗夜黑", "Night Black", "dark", "#0c0c0e"],
  ["zai-light", "草木灰", "Botanical Gray", "light", "#f8fafc"],
  ["sepia-light", "落晖黄", "Sunset Yellow", "light", "#faf7f2"],
  ["midnight-blue", "天空蓝", "Sky Blue", "light", "#eef7ff"],
  ["forest-dark", "远山绿", "Mountain Green", "light", "#f1f7ed"],
  ["cinnabar", "朱砂红", "Cinnabar Red", "light", "#fff3ef"],
  ["inkpurple", "烟墨紫", "Ink Purple", "dark", "#141019"],
];

test(
  "global theme quality: actual shared components, first paint and persistence",
  { timeout: 240_000 },
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
    let output = "";
    server.stdout.on("data", (data) => {
      output += data;
    });
    server.stderr.on("data", (data) => {
      output += data;
    });
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
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const origin = `http://127.0.0.1:${port}`;
    const fixture = `${origin}/test/fixtures/theme-quality.html`;
    const artifacts = fileURLToPath(new URL("../../../.lcode/theme-quality/", import.meta.url));
    await mkdir(artifacts, { recursive: true });
    const load = async (english = false, font = 14) => {
      await page.goto(`${fixture}?font=${font}${english ? "&english" : ""}`);
      await page.locator("[data-v4-draft-greeting]").waitFor();
    };
    const select = async (entry, english = false) => {
      await page.getByRole("button", { name: entry[english ? 2 : 1], exact: true }).click();
      assert.equal(await page.evaluate(() => localStorage.getItem("lcode-theme")), entry[0]);
      assert.deepEqual(
        await page.evaluate(() =>
          Array.from(document.documentElement.classList).filter((name) =>
            name.startsWith("theme-"),
          ),
        ),
        [`theme-${entry[0]}`],
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.classList.contains("dark")),
        entry[3] === "dark",
      );
      assert.equal(
        await page
          .locator("html")
          .evaluate((el) => getComputedStyle(el).getPropertyValue("--color-background").trim()),
        entry[4],
      );
    };

    await t.test(
      "seven palettes, Chinese/English, normal/large type and clipped greeting regression",
      async () => {
        for (const english of [false, true])
          for (const font of [14, 20]) {
            await load(english, font);
            assert.equal(await page.getByRole("group").getByRole("button").count(), 8);
            for (const entry of themes) {
              await page.emulateMedia({
                colorScheme: entry[3] === "dark" ? "light" : "dark",
                reducedMotion: "reduce",
              });
              await select(entry, english);
              for (const [width, height] of [
                [1440, 900],
                [1280, 720],
                [827, 547],
                [390, 844],
                [320, 568],
              ]) {
                await page.setViewportSize({ width, height });
                const croppedLabels = await page
                  .getByRole("group")
                  .getByRole("button")
                  .evaluateAll((buttons) =>
                    buttons.flatMap((button) => {
                      const label = button.querySelector(".flex-1");
                      const range = document.createRange();
                      range.selectNodeContents(label);
                      const bounds = label.getBoundingClientRect();
                      return Array.from(range.getClientRects()).some(
                        (r) => r.right > bounds.right + 1 || r.bottom > bounds.bottom + 1,
                      )
                        ? [label.textContent]
                        : [];
                    }),
                  );
                assert.deepEqual(croppedLabels, [], `theme names at ${width}px/${font}px`);
                await page.locator("main").evaluate((el) => {
                  el.scrollTop = 0;
                });
                const greeting = await page.locator("[data-v4-draft-greeting]").evaluate((el) => {
                  const rect = el.getBoundingClientRect();
                  const range = document.createRange();
                  range.selectNodeContents(el);
                  return {
                    width: rect.width,
                    height: rect.height,
                    scrollWidth: el.scrollWidth,
                    font: Number.parseFloat(getComputedStyle(el).fontSize),
                    textRects: Array.from(range.getClientRects(), (r) => ({
                      top: r.top - rect.top,
                      bottom: r.bottom - rect.top,
                      right: r.right - rect.left,
                    })),
                    pageWidth: document.documentElement.scrollWidth,
                  };
                });
                assert.equal(greeting.font, font + (width < 640 ? 10 : 16));
                assert.ok(greeting.scrollWidth <= greeting.width + 1, JSON.stringify(greeting));
                assert.ok(
                  greeting.textRects.every(
                    (r) =>
                      r.top >= -1 &&
                      r.bottom <= greeting.height + 1 &&
                      r.right <= greeting.width + 1,
                  ),
                  JSON.stringify(greeting),
                );
                assert.ok(greeting.pageWidth <= width);
                const logo = await page.locator("[data-v4-draft-logo]").evaluate((el) => ({
                  loaded: el.complete && el.naturalWidth > 0,
                  opacity: getComputedStyle(el).opacity,
                  mask: getComputedStyle(el).maskImage,
                  top: el.getBoundingClientRect().top,
                  bottom: el.getBoundingClientRect().bottom,
                  frameBottom: el.parentElement.getBoundingClientRect().bottom,
                  width: el.getBoundingClientRect().width,
                }));
                assert.ok(logo.loaded);
                assert.equal(logo.opacity, entry[3] === "dark" ? "0.32" : "0.24");
                assert.match(logo.mask, /linear-gradient/);
                assert.ok(
                  logo.width > 120 && logo.width <= Math.min(width * 0.6, 320, height * 0.32) + 1,
                );
                assert.ok(logo.top >= 0 && logo.frameBottom <= height, JSON.stringify(logo));
              }
              await page.setViewportSize({ width: 1280, height: 720 });
              await page.screenshot({
                path: `${artifacts}/${entry[0]}-${english ? "en" : "zh"}-${font}.png`,
                fullPage: false,
              });
            }
          }
      },
    );

    await runWelcomeLayoutQualityCases({ t, page, browser, fixture, artifacts });

    await t.test(
      "selected root controls dark utilities and color-scheme regardless of OS",
      async () => {
        await load();
        for (const entry of themes) {
          await page.emulateMedia({ colorScheme: entry[3] === "dark" ? "light" : "dark" });
          await select(entry);
          const values = await page.getByTestId("dark-variant").evaluate((el) => {
            const root = getComputedStyle(document.documentElement);
            const probe = document.createElement("div");
            probe.style.backgroundColor = root.getPropertyValue(
              document.documentElement.classList.contains("dark")
                ? "--color-primary"
                : "--color-card",
            );
            document.body.append(probe);
            const expected = getComputedStyle(probe).backgroundColor;
            probe.remove();
            return {
              actual: getComputedStyle(el).backgroundColor,
              expected,
              scheme: root.colorScheme,
            };
          });
          assert.equal(values.actual, values.expected);
          assert.equal(values.scheme, entry[3]);
          await page.reload();
          await page.locator("[data-v4-draft-greeting]").waitFor();
          assert.equal(
            await page
              .getByRole("button", { name: entry[1], exact: true })
              .getAttribute("aria-pressed"),
            "true",
          );
        }
      },
    );

    await runThemeQualityInteractionCases({
      t,
      page,
      context,
      fixture,
      origin,
      select,
      themes,
      load,
      errors,
    });

    await t.test(
      "HTML first paint uses the registry before application scripts; legacy and system",
      async () => {
        // 读取真实 Vite HTML，只阻止模块执行，观察内联首屏投影而非 React 最终状态。
        await page.route(`${origin}/src/main.tsx*`, (route) => route.abort());
        for (const entry of [
          ...themes,
          ["light", "", "", "light", "#f8fafc"],
          ["dark", "", "", "dark", "#0c0c0e"],
          ["invalid", "", "", "dark", "#0c0c0e"],
        ]) {
          await page.goto(fixture);
          await page.evaluate((id) => localStorage.setItem("lcode-theme", id), entry[0]);
          await page.goto(`${origin}/`);
          assert.equal(
            await page.locator('meta[name="theme-color"]').getAttribute("content"),
            entry[4],
          );
          assert.equal(
            await page.locator("html").getAttribute("data-lcode-bootstrap-theme"),
            entry[3],
          );
        }
        await page.goto(fixture);
        await page.evaluate(() => localStorage.setItem("lcode-theme", "system"));
        await page.emulateMedia({ colorScheme: "light" });
        await page.goto(`${origin}/`);
        assert.equal(
          await page.locator("html").getAttribute("data-lcode-bootstrap-theme"),
          "light",
        );
        await page.goto(fixture);
        await page.evaluate(() => localStorage.removeItem("lcode-theme"));
        for (const path of ["/share", "/share/example", "/cn/share", "/cn/share/example"]) {
          await page.goto(origin + path);
          assert.equal(
            await page.locator("html").getAttribute("data-lcode-bootstrap-theme"),
            "light",
          );
        }
        await page.unroute(`${origin}/src/main.tsx*`);
      },
    );
    // BroadcastChannel 不证明生产跨 Host 消息传输；测试覆盖真实 store 的接收/防回环路径。
    assert.deepEqual(errors, []);
  },
);
