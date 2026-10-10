import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";
import { runMobilePlatformQualityCases } from "./component-mobile-platform-cases.mjs";
import { runElectronQualityCase } from "./component-electron-cases.mjs";
import { runOverlayQualityCases } from "./component-overlay-cases.mjs";

const themes = [
  "zai-dark",
  "zai-light",
  "sepia-light",
  "midnight-blue",
  "forest-dark",
  "cinnabar",
  "inkpurple",
];
const labels = ["暗夜黑", "草木灰", "落晖黄", "天空蓝", "远山绿", "朱砂红", "烟墨紫"];
const visibleBounds = async (locator, width, height) => {
  const box = await locator.boundingBox();
  assert.ok(
    box &&
      box.x >= -1 &&
      box.y >= -1 &&
      box.x + box.width <= width + 1 &&
      box.y + box.height <= height + 1,
    JSON.stringify(box),
  );
};

test(
  "component quality: semantic tokens, forms, bounded overlays and production screens",
  { timeout: 240_000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const origin = `http://127.0.0.1:${port}`;
    const artifacts = fileURLToPath(new URL("../../../.lcode/component-quality/", import.meta.url));
    await mkdir(artifacts, { recursive: true });
    const load = async (font = 20, english = false, selectPosition = "popper") => {
      await page.goto(
        `${origin}/test/fixtures/theme-quality.html?controls&font=${font}&select-position=${selectPosition}${english ? "&english" : ""}`,
      );
      await page.getByTestId("quality-input-group").waitFor();
    };

    await t.test(
      "aliases and native controls; single-line defaults, large type and state semantics",
      async () => {
        for (const font of [12, 14, 20]) {
          await load(font);
          for (let i = 0; i < themes.length; i++) {
            await page.getByRole("button", { name: labels[i], exact: true }).click();
            const missing = await page.evaluate(() =>
              [
                "--color-muted",
                "--color-muted-foreground",
                "--color-ring",
                "--color-secondary-foreground",
              ].filter(
                (name) => !getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
              ),
            );
            assert.deepEqual(missing, []);
            assert.equal(
              await page
                .getByTestId("single-line")
                .evaluate((el) => getComputedStyle(el).whiteSpace),
              "nowrap",
            );
            for (const locator of [
              page.getByRole("combobox", { name: "Quality select" }),
              page.getByTestId("quality-input-group"),
              page.getByTestId("quality-badge"),
            ]) {
              assert.ok(
                await locator.evaluate((el) => {
                  const range = document.createRange();
                  range.selectNodeContents(el);
                  const r = el.getBoundingClientRect();
                  return Array.from(range.getClientRects()).every(
                    (v) => v.top >= r.top - 1 && v.bottom <= r.bottom + 1,
                  );
                }),
              );
            }
            const input = page.getByRole("spinbutton", { name: "Quality number" });
            await input.fill("3");
            await input.press("ArrowUp");
            assert.equal(await input.inputValue(), "4");
            assert.equal(
              await input.evaluate((el) => getComputedStyle(el).appearance),
              "textfield",
            );
            await page
              .getByRole("checkbox", { name: "Quality checkbox", exact: true })
              .press("Space");
            assert.equal(
              await page
                .getByRole("checkbox", { name: "Quality checkbox", exact: true })
                .getAttribute("aria-checked"),
              i % 2 === 0 ? "true" : "false",
            );
            assert.equal(
              await page
                .getByRole("checkbox", { name: "Mixed checkbox" })
                .getAttribute("aria-checked"),
              "mixed",
            );
            await page.getByRole("switch", { name: "Quality switch", exact: true }).press("Space");
            assert.equal(
              await page
                .getByRole("switch", { name: "Quality switch", exact: true })
                .getAttribute("aria-checked"),
              i % 2 === 0 ? "true" : "false",
            );
            assert.equal(
              await page.getByRole("switch", { name: "Disabled switch" }).isDisabled(),
              true,
            );
            const radio = page.getByRole("radio").first();
            assert.equal(
              await radio.evaluate((el) => getComputedStyle(el).accentColor),
              await input
                .evaluate((el) => getComputedStyle(el).getPropertyValue("--color-primary").trim())
                .then((hex) =>
                  page.evaluate((color) => {
                    const el = document.createElement("span");
                    el.style.color = color;
                    document.body.append(el);
                    const result = getComputedStyle(el).color;
                    el.remove();
                    return result;
                  }, hex),
                ),
            );
          }
        }
      },
    );

    await runOverlayQualityCases({ t, page, load, visibleBounds });

    await t.test(
      "autofill pseudo styles preserve theme text, fill and error ring; notification text scales",
      async () => {
        await load();
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("DOM.enable");
        await cdp.send("CSS.enable");
        const { root } = await cdp.send("DOM.getDocument");
        const { nodeId } = await cdp.send("DOM.querySelector", {
          nodeId: root.nodeId,
          selector: '[aria-label="Invalid input"]',
        });
        for (let i = 0; i < themes.length; i++) {
          await page.getByRole("button", { name: labels[i], exact: true }).click();
          await cdp.send("CSS.forcePseudoState", {
            nodeId,
            forcedPseudoClasses: ["autofill", "focus", "focus-visible"],
          });
          const style = await page
            .getByRole("textbox", { name: "Invalid input" })
            .evaluate((el) => {
              const css = getComputedStyle(el);
              // autofill 的 UA color 可被强制；字形 text-fill 应读取真实主题前景。
              const probe = document.createElement("span");
              probe.style.color = css.getPropertyValue("--color-foreground");
              document.body.append(probe);
              const expectedText = getComputedStyle(probe).color;
              probe.remove();
              return {
                active: el.matches(":autofill"),
                shadow: css.boxShadow,
                color: expectedText,
                text: css.webkitTextFillColor,
              };
            });
          assert.equal(style.active, true);
          assert.ok(
            style.shadow.includes("1000px") && style.shadow.includes("inset"),
            style.shadow,
          );
          assert.equal(style.text, style.color);
          await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
        }
        await cdp.detach();
        await page.setViewportSize({ width: 320, height: 568 });
        const toast = page.getByTestId("quality-toast").getByRole("status");
        await toast.waitFor();
        assert.equal(await toast.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)), 20);
        await toast.scrollIntoViewIfNeeded();
        await visibleBounds(toast, 320, 568);
        assert.ok(await toast.evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
        await page.getByRole("button", { name: "Dismiss notice" }).click();
        await toast.waitFor({ state: "hidden" });
      },
    );

    await t.test(
      "long Dialog retains header/footer, nested Escape scope and trigger focus",
      async () => {
        await load();
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole("button", { name: "Long dialog", exact: true }).click();
        const outer = page.getByRole("dialog");
        await outer.waitFor();
        await visibleBounds(outer, 390, 844);
        await page.getByTestId("long-dialog-body").evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        await visibleBounds(page.getByRole("heading", { name: "Long dialog title" }), 390, 844);
        await visibleBounds(
          page.getByRole("button", { name: "Finish dialog", exact: true }),
          390,
          844,
        );
        await page.getByRole("button", { name: "Nested dialog", exact: true }).click();
        await page.getByRole("textbox", { name: "Nested input" }).waitFor();
        // 可见早于 Radix 的自动聚焦；键盘事件从已接管焦点的当前 scope 发出。
        await page.waitForFunction(
          () => document.activeElement?.getAttribute("aria-label") === "Nested input",
        );
        await page.keyboard.press("Escape");
        await page.getByRole("textbox", { name: "Nested input" }).waitFor({ state: "hidden" });
        await page.waitForFunction(() => document.activeElement?.textContent === "Nested dialog");
        assert.equal(
          await page
            .getByRole("button", { name: "Nested dialog", exact: true })
            .evaluate((el) => el === document.activeElement),
          true,
        );
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => document.activeElement?.textContent === "Long dialog");
        assert.equal(
          await page
            .getByRole("button", { name: "Long dialog", exact: true })
            .evaluate((el) => el === document.activeElement),
          true,
        );
      },
    );

    await t.test(
      "production workflow form scrolls its body while actions remain visible",
      async () => {
        await load();
        for (const [width, height] of [
          [390, 844],
          [844, 390],
        ]) {
          await page.setViewportSize({ width, height });
          await page.getByRole("button", { name: "Production workflow", exact: true }).click();
          const dialog = page.getByRole("dialog");
          await dialog.waitFor();
          await visibleBounds(dialog, width, height);
          await visibleBounds(dialog.locator('[data-slot="dialog-footer"]'), width, height);
          const last = dialog.getByRole("textbox").last();
          await last.focus();
          await visibleBounds(last, width, height);
          await visibleBounds(dialog.getByRole("heading"), width, height);
          await page.screenshot({ path: `${artifacts}/workflow-${width}.png` });
          await page.keyboard.press("Escape");
        }
      },
    );

    await t.test(
      "actual SettingsPage, theme selection and large Chinese/English labels",
      async () => {
        for (const english of [false, true])
          for (const [width, height] of [
            [390, 844],
            [1280, 720],
          ]) {
            await page.setViewportSize({ width, height });
            await page.goto(
              `${origin}/test/fixtures/mobile-layout.html?font=20&lang=${english ? "en" : "zh"}&theme=inkpurple`,
            );
            await page
              .getByTestId("fixture-controls")
              .getByRole("button", { name: "Settings page / 设置页", exact: true })
              .click();
            await page
              .getByRole("heading", { name: english ? "General" : "常规", exact: true })
              .waitFor();
            assert.ok(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            );
            await page.screenshot({
              path: `${artifacts}/settings-${width}-${english ? "en" : "zh"}.png`,
            });
          }
      },
    );
    await runMobilePlatformQualityCases({ t, browser, page, origin, artifacts, visibleBounds });
    await runElectronQualityCase({ t, origin, artifacts, visibleBounds });
    assert.deepEqual(errors, []);
  },
);
