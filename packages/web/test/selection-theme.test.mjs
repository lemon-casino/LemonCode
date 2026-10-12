import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

const themes = [
  "zai-dark",
  "zai-light",
  "sepia-light",
  "midnight-blue",
  "forest-dark",
  "cinnabar",
  "inkpurple",
];

async function selectionIsVisible(page, selected, container) {
  await selected.scrollIntoViewIfNeeded();
  await page.mouse.move(1, 1);
  await selected.evaluate(async (el) => {
    // 浏览器在 pointer/focus 切换时会取消旧颜色过渡；取消不代表选中状态被清除。
    await Promise.all(el.getAnimations().map((animation) => animation.finished.catch(() => {})));
  });
  const background = await selected.evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.notEqual(background, "rgba(0, 0, 0, 0)", "selection must retain a fill");
  const parentBackground = await container.evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.notEqual(background, parentBackground, "selected fill must differ from its container");
  const before = background;
  await selected.hover();
  await selected.evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((animation) => animation.finished.catch(() => {})));
  });
  assert.equal(
    await selected.evaluate((el) => getComputedStyle(el).backgroundColor),
    before,
    "hover must preserve selection",
  );
}

test(
  "selected controls and answer fields remain visible in all seven themes",
  { timeout: 300_000 },
  async (t) => {
    const { browser, port, diagnostics } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, [], diagnostics()));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await mkdir(".tmp/selection-theme", { recursive: true });
    for (const lang of ["zh", "en"]) {
      await page.goto(`http://127.0.0.1:${port}/test/fixtures/selection-theme.html?lang=${lang}`, {
        timeout: 60_000,
      });
      const plugin = page.getByTestId("selection-plugin");
      const automation = page.getByTestId("selection-automation");
      const usage = page.getByTestId("selection-usage");
      const question = page.getByTestId("selection-question");
      const rust = question.getByRole("checkbox", { name: /Rust \+ Node.js/ });
      const java = question.getByRole("checkbox", { name: /Java/ });
      const answer = question.getByRole("textbox");
      await automation.locator('[aria-pressed="true"]').first().waitFor();
      for (const theme of themes) {
        await page.getByLabel("Fixture theme").selectOption(theme);
        const colors = await page.evaluate(() => {
          const s = getComputedStyle(document.documentElement);
          return ["background", "hover", "selected"].map((key) =>
            s.getPropertyValue(`--color-${key}`).trim(),
          );
        });
        assert.equal(new Set(colors).size, 3, `${theme} must have three distinct palette roles`);
        const contrasts = await page.evaluate(() => {
          const style = getComputedStyle(document.documentElement);
          const ctx = document.createElement("canvas").getContext("2d");
          const luminance = (token) => {
            ctx.fillStyle = style.getPropertyValue(`--color-${token}`).trim();
            ctx.fillRect(0, 0, 1, 1);
            return Array.from(ctx.getImageData(0, 0, 1, 1).data)
              .slice(0, 3)
              .map((v) => v / 255)
              .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
              .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
          };
          return ["foreground", "foreground-subtle"].flatMap((foreground) =>
            ["selected", "hover", "popover"].map((background) => {
              const a = luminance(foreground),
                b = luminance(background);
              return [
                `${foreground}/${background}`,
                (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
              ];
            }),
          );
        });
        for (const [role, ratio] of contrasts)
          assert.ok(ratio >= 4.5, `${theme} ${role}: ${ratio}`);
        for (const [width, height, font] of [
          [1280, 900, 14],
          [390, 844, 20],
          [320, 568, 20],
        ]) {
          await page.setViewportSize({ width, height });
          await page.evaluate(
            (value) => document.documentElement.style.setProperty("--ui-font-size", `${value}px`),
            font,
          );
          for (const surface of [plugin, automation]) {
            const pills = surface.locator("button[aria-pressed]");
            await pills.last().click();
            await selectionIsVisible(
              page,
              surface.locator('button[aria-pressed="true"]').last(),
              surface,
            );
            await pills.first().click();
            await selectionIsVisible(
              page,
              surface.locator('button[aria-pressed="true"]').first(),
              surface,
            );
          }
          const usagePills = usage.locator("button[aria-pressed]");
          await usagePills.last().click();
          await selectionIsVisible(page, usage.locator('button[aria-pressed="true"]'), usage);
          await usagePills.first().click();
          for (const list of await usage.getByRole("tablist").all()) {
            await list.getByRole("tab").first().focus();
            await page.keyboard.press("ArrowRight");
            await selectionIsVisible(page, list.getByRole("tab", { selected: true }), list);
          }
          const zeroCell = usage.locator(".aspect-square").first();
          assert.notEqual(
            await zeroCell.evaluate((el) => getComputedStyle(el).backgroundColor),
            await zeroCell
              .locator('xpath=ancestor::div[contains(@class,"bg-surface")]')
              .evaluate((el) => getComputedStyle(el).backgroundColor),
            "zero-usage grid must remain visible",
          );
          await rust.click();
          await java.click();
          const checked = await rust.getAttribute("aria-checked");
          assert.equal(checked, await java.getAttribute("aria-checked"));
          if (checked !== "true") {
            await rust.click();
            await java.click();
          }
          await rust.focus();
          await selectionIsVisible(page, rust, question.locator("[data-elicitation-dialog-card]"));
          const unchecked = question
            .getByRole("checkbox", { name: /Python/ })
            .locator("span")
            .first();
          const indicator = await unchecked.evaluate((el) => {
            const s = getComputedStyle(el);
            return {
              border: s.borderTopColor,
              width: parseFloat(s.borderTopWidth),
              parent: getComputedStyle(el.closest("[data-elicitation-dialog-card]"))
                .backgroundColor,
            };
          });
          assert.ok(
            indicator.width > 0 && indicator.border !== indicator.parent,
            "unchecked options need a visible outline",
          );
          await answer.fill("Additional ecosystem");
          await answer.focus();
          const input = await answer.evaluate((el) => {
            const s = getComputedStyle(el);
            return {
              background: s.backgroundColor,
              border: s.borderTopColor,
              width: parseFloat(s.borderTopWidth),
              parent: getComputedStyle(el.parentElement).backgroundColor,
            };
          });
          assert.notEqual(
            input.background,
            "rgba(0, 0, 0, 0)",
            "custom answer must retain the input surface",
          );
          assert.ok(
            input.width > 0 && input.border !== input.parent,
            "custom answer must retain a visible focus border",
          );
          assert.ok(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            `${theme}/${lang}/${width}: horizontal overflow`,
          );
          if (width !== 320)
            await question.screenshot({
              path: `.tmp/selection-theme/question-${theme}-${lang}-${width}.png`,
            });
        }
      }
      await answer.press("Control+Enter");
      const result = JSON.parse(await page.getByTestId("selection-answer").innerText());
      assert.equal(result.action, "accept");
      const values = Object.values(result.content).flat();
      for (const value of ["rust", "java", "Additional ecosystem"])
        assert.ok(values.includes(value));
    }
  },
);

test(
  "settings navigation retains a visible selected item on wide and narrow layouts",
  { timeout: 180_000 },
  async (t) => {
    const { browser, port, diagnostics } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, [], diagnostics()));
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const lang of ["zh", "en"]) {
      for (const theme of themes) {
        await page.setViewportSize({ width: 1280, height: 720 });
        await page.goto(
          `http://127.0.0.1:${port}/test/fixtures/mobile-layout.html?theme=${theme}&lang=${lang}`,
          { timeout: 60_000 },
        );
        await page
          .getByTestId("fixture-controls")
          .getByRole("button", { name: "Settings page / 设置页", exact: true })
          .click();
        const settings = page.getByTestId("settings-page");
        const nav = settings.locator("nav");
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 844 });
          const target = nav.getByRole("button", {
            name: lang === "en" ? "Appearance" : "外观",
            exact: true,
          });
          await target.click();
          assert.equal(await settings.getAttribute("data-active-section"), "appearance");
          assert.equal(await nav.locator('[aria-current="page"]').count(), 1);
          await selectionIsVisible(
            page,
            target,
            settings.locator("xpath=ancestor::*[@data-desktop-window-frame]"),
          );
          if (width === 1280) {
            const activeText = await target
              .locator("span span")
              .evaluate((el) => getComputedStyle(el).color);
            const inactiveText = await nav
              .getByRole("button", { name: lang === "en" ? "General" : "常规", exact: true })
              .locator("span span")
              .evaluate((el) => getComputedStyle(el).color);
            assert.notEqual(
              activeText,
              inactiveText,
              "navigation labels must inherit active/inactive colors",
            );
          }
        }
      }
    }
  },
);

test(
  "shared controls, permission feedback, Git selection and system palettes",
  { timeout: 120_000 },
  async (t) => {
    const { browser, port, diagnostics } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, [], diagnostics()));
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/selection-theme.html?extras&single`, {
      timeout: 60_000,
    });
    for (const theme of themes) {
      await page.getByLabel("Fixture theme").selectOption(theme);
      const shared = page.getByTestId("selection-shared");
      const history = shared.getByRole("tab", { name: "All history", exact: true });
      await history.click();
      await selectionIsVisible(page, history, history.locator("xpath=.."));
      const line = shared.getByRole("tab", { name: "Line two", exact: true });
      await line.click();
      await line.evaluate(async (el) => {
        await Promise.all(
          el.getAnimations().map((animation) => animation.finished.catch(() => {})),
        );
      });
      assert.equal(await line.evaluate((el) => getComputedStyle(el, "::after").opacity), "1");
      const checkbox = shared.getByRole("checkbox", { name: "Shared checkbox" });
      await checkbox.check();
      await checkbox.evaluate(async (el) => {
        await Promise.all(
          el.getAnimations().map((animation) => animation.finished.catch(() => {})),
        );
      });
      const checkStyle = await checkbox.evaluate((el) => ({
        background: getComputedStyle(el).backgroundColor,
        color: getComputedStyle(el).color,
      }));
      assert.notEqual(
        checkStyle.background,
        checkStyle.color,
        `${theme}: shared checkmark uses the matching foreground`,
      );
      await checkbox.uncheck();
      assert.notEqual(
        await checkbox.evaluate((el) => getComputedStyle(el).borderTopColor),
        await shared.evaluate((el) => getComputedStyle(el).backgroundColor),
      );
      const sharedInput = shared.getByRole("textbox", { name: "Shared input" });
      await sharedInput.fill("Fixture input");
      await sharedInput.focus();
      assert.notEqual(
        await sharedInput.evaluate((el) => getComputedStyle(el).borderTopColor),
        await shared.evaluate((el) => getComputedStyle(el).backgroundColor),
      );
      const option = page
        .getByTestId("selection-question")
        .getByRole("option", { name: /Rust \+ Node.js/ });
      await option.click();
      await option.focus();
      await selectionIsVisible(
        page,
        option,
        page.getByTestId("selection-question").locator("[data-elicitation-dialog-card]"),
      );
      const git = page.getByTestId("selection-git");
      const commit = git.getByRole("button", { name: /Fixture commit/ });
      await commit.focus();
      await selectionIsVisible(page, commit, git.locator("section").first());
      const feedback = page.getByTestId("selection-permission").getByRole("textbox");
      await feedback.fill("Fixture feedback");
      await feedback.focus();
      assert.notEqual(
        await feedback.evaluate((el) => getComputedStyle(el).backgroundColor),
        "rgba(0, 0, 0, 0)",
      );
      assert.notEqual(
        await feedback.evaluate((el) => getComputedStyle(el).borderTopColor),
        await feedback.locator("xpath=..").evaluate((el) => getComputedStyle(el).backgroundColor),
      );
    }
    for (const [colorScheme, expectedTheme] of [
      ["light", "zai-light"],
      ["dark", "zai-dark"],
    ]) {
      await page.emulateMedia({ colorScheme });
      await page.getByLabel("Fixture theme").selectOption("system");
      assert.ok(
        await page
          .locator("html")
          .evaluate((el, theme) => el.classList.contains(`theme-${theme}`), expectedTheme),
      );
    }
  },
);
