import assert from "node:assert/strict";

export async function runThemeQualityInteractionCases({
  t,
  page,
  context,
  fixture,
  origin,
  select,
  themes,
  load,
  errors,
}) {
  await t.test("large controls, keyboard focus, menu/dialog and semantic contrast", async () => {
    await load(false, 20);
    for (const entry of themes) {
      await select(entry);
      const button = page.getByTestId("primary");
      await button.focus();
      await button.press("Tab");
      const focus = await page.evaluate(() => {
        const s = getComputedStyle(document.activeElement);
        return { outline: s.outlineStyle, width: s.outlineWidth, shadow: s.boxShadow };
      });
      assert.ok(
        (focus.outline !== "none" && parseFloat(focus.width) > 0) || focus.shadow !== "none",
        JSON.stringify(focus),
      );
      for (const locator of [
        button,
        page.getByRole("textbox", { name: "Quality input", exact: true }),
      ]) {
        assert.ok(
          await locator.evaluate(
            (el) => el.clientHeight >= parseFloat(getComputedStyle(el).lineHeight),
          ),
        );
      }
      await page.getByRole("button", { name: "菜单", exact: true }).click();
      const menu = page.getByRole("menu");
      await menu.waitFor();
      assert.notEqual(await menu.evaluate((el) => getComputedStyle(el).boxShadow), "none");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "弹窗", exact: true }).click();
      await page.getByRole("dialog").waitFor();
      // Portal 可见早于 Radix 的焦点 effect；按实际输入焦点确认 scope 已就绪。
      await page.waitForFunction(
        () => document.activeElement?.getAttribute("aria-label") === "Dialog input",
      );
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "弹窗");
      assert.equal(
        await page
          .getByRole("button", { name: "弹窗", exact: true })
          .evaluate((el) => el === document.activeElement),
        true,
      );
      const contrasts = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        const color = (token) => {
          const canvas = document.createElement("canvas");
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = style.getPropertyValue(token).trim();
          ctx.fillRect(0, 0, 1, 1);
          return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
        };
        const luminance = (rgb) =>
          rgb
            .map((v) => v / 255)
            .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
            .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
        const ratio = (a, b) => {
          const x = luminance(color(a));
          const y = luminance(color(b));
          return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
        };
        return [
          ["body", ratio("--color-foreground", "--color-background")],
          ["secondary", ratio("--color-foreground-subtle", "--color-card")],
          ["muted", ratio("--color-foreground-subtlest", "--color-input")],
          ["button", ratio("--color-primary-foreground", "--color-primary")],
          ["error", ratio("--color-destructive-foreground", "--color-destructive")],
        ];
      });
      for (const [role, ratio] of contrasts)
        assert.ok(ratio >= 4.5, `${entry[0]} ${role}: ${ratio}`);
    }
  });

  await t.test(
    "real store broadcast has no echo; actual resource window follows storage and system",
    async () => {
      await load();
      const other = await context.newPage();
      await other.goto(fixture);
      await other.locator("[data-v4-draft-greeting]").waitFor();
      const resource = await context.newPage();
      resource.on("pageerror", (error) => errors.push(error.message));
      await resource.goto(`${origin}/test/fixtures/resource-theme.html`);
      await resource.waitForFunction(() => document.documentElement.className.includes("theme-"));
      await select(themes[5]);
      await other
        .getByRole("button", { name: "朱砂红", exact: true })
        .filter({ has: other.locator("[aria-hidden]") })
        .waitFor();
      await other.waitForFunction(() =>
        document.documentElement.classList.contains("theme-cinnabar"),
      );
      await resource.waitForFunction(() =>
        document.documentElement.classList.contains("theme-cinnabar"),
      );
      assert.equal(await page.locator("body").getAttribute("data-theme-send-count"), "1");
      assert.equal(await other.locator("body").getAttribute("data-theme-send-count"), null);
      assert.equal(
        await resource.locator("html").evaluate((el) => getComputedStyle(el).backgroundColor),
        "rgba(0, 0, 0, 0)",
      );
      await other.getByRole("button", { name: "烟墨紫", exact: true }).click();
      await page.waitForFunction(() =>
        document.documentElement.classList.contains("theme-inkpurple"),
      );
      await resource.waitForFunction(() =>
        document.documentElement.classList.contains("theme-inkpurple"),
      );
      assert.equal(await page.locator("body").getAttribute("data-theme-send-count"), "1");
      assert.equal(await other.locator("body").getAttribute("data-theme-send-count"), "1");
      await page.emulateMedia({ colorScheme: "dark" });
      await resource.emulateMedia({ colorScheme: "dark" });
      await page.getByRole("button", { name: "系统", exact: true }).click();
      await resource.waitForFunction(() =>
        document.documentElement.classList.contains("theme-zai-dark"),
      );
      await resource.emulateMedia({ colorScheme: "light" });
      await resource.waitForFunction(() =>
        document.documentElement.classList.contains("theme-zai-light"),
      );
      assert.equal(await page.evaluate(() => localStorage.getItem("lcode-theme")), "system");
      await resource.close();
      await other.close();
    },
  );
}
