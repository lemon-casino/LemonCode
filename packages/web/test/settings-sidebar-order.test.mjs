import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "设置侧栏按名称短到长排列，文字与图标尺寸在主题、选中态和手机保持一致",
  { timeout: 180_000 },
  async (t) => {
    const { browser, port, diagnostics } = await startWorkflowProgressBrowser(t);
    const themes = [
      "zai-light",
      "zai-dark",
      "sepia-light",
      "midnight-blue",
      "forest-dark",
      "cinnabar",
      "inkpurple",
    ];
    for (const width of [1280, 390]) {
      for (const language of ["zh", "en"]) {
        for (const theme of width === 1280 ? themes : ["zai-light", "zai-dark"]) {
          const page = await browser.newPage({ viewport: { width, height: 1000 } });
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          try {
            await page.goto(
              `http://127.0.0.1:${port}/test/fixtures/mobile-layout.html?view=settings&lang=${language}&theme=${theme}&font=20`,
            );
            const nav = page.getByRole("navigation", {
              name: language === "zh" ? "主要项" : "Sections",
              exact: true,
            });
            await nav.waitFor();
            const read = () =>
              nav.evaluate((element) =>
                [...element.querySelectorAll('[role="group"]')].map((group) =>
                  [...group.querySelectorAll("button")].map((button) => {
                    const text = button.lastElementChild.lastElementChild;
                    const icon = button.querySelector("svg").getBoundingClientRect();
                    const style = getComputedStyle(text);
                    return {
                      name: button.getAttribute("aria-label"),
                      font: style.fontSize,
                      weight: style.fontWeight,
                      iconWidth: icon.width,
                      iconHeight: icon.height,
                    };
                  }),
                ),
              );
            const before = await read();
            const all = before.flat();
            assert.ok(all.length > 10);
            for (const group of before) {
              const lengths = group.map((row) => [...row.name.replace(/\s/gu, "")].length);
              for (let index = 1; index < lengths.length; index++)
                assert.ok(
                  lengths[index] >= lengths[index - 1],
                  JSON.stringify({ language, group }),
                );
            }
            for (const property of ["font", "weight", "iconWidth", "iconHeight"])
              assert.equal(
                new Set(all.map((row) => row[property])).size,
                1,
                `${property}: ${JSON.stringify(all)}`,
              );
            assert.equal(all[0].weight, "500");
            const entry = nav.getByRole("button", {
              name: language === "zh" ? "Token 用量状态栏" : "Token usage status bar",
              exact: true,
            });
            await entry.click();
            await page.getByTestId("token-usage-statusbar-settings").waitFor();
            assert.equal(await entry.getAttribute("aria-current"), "page");
            assert.deepEqual(await read(), before);
            assert.ok(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            );
            if (
              process.env.LCODE_TEST_SCREENSHOT_DIR &&
              width === 1280 &&
              language === "zh" &&
              ["zai-light", "zai-dark", "sepia-light"].includes(theme)
            ) {
              await mkdir(process.env.LCODE_TEST_SCREENSHOT_DIR, { recursive: true });
              await nav.screenshot({
                path: `${process.env.LCODE_TEST_SCREENSHOT_DIR}/settings-sidebar-${theme}.png`,
              });
            }
            assert.deepEqual(errors, [], diagnostics());
          } finally {
            await page.close();
          }
        }
      }
    }
  },
);
