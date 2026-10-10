import assert from "node:assert/strict";

async function assertMenuGlyphsFit(locator) {
  assert.ok(
    await locator.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const row = el.getBoundingClientRect();
      return Array.from(range.getClientRects()).every(
        (r) =>
          r.left >= row.left && r.right <= row.right && r.top >= row.top && r.bottom <= row.bottom,
      );
    }),
  );
}

export async function runOverlayQualityCases({ t, page, load, visibleBounds }) {
  await t.test(
    "Select, Popover, dropdown and context menu fit narrow/short viewports and can reach the final item",
    async () => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      for (const selectPosition of ["popper", "item-aligned"])
        for (const [width, height] of [
          [320, 568],
          [320, 400],
          [844, 390],
          [1280, 720],
        ]) {
          await page.setViewportSize({ width, height });
          await load(20, false, selectPosition);
          await page.getByRole("combobox", { name: "Quality select" }).click();
          const select = page.locator('[data-slot="select-content"]');
          await select.waitFor();
          await visibleBounds(select, width, height);
          // Radix 的挂载回焦在内容可见之后执行；先等焦点，再发送导航键。
          await page.waitForFunction(
            () => document.activeElement?.getAttribute("role") === "option",
          );
          assert.ok(
            await page
              .getByRole("option")
              .first()
              .evaluate((el) => {
                const range = document.createRange();
                range.selectNodeContents(el.lastElementChild);
                const row = el.getBoundingClientRect();
                return Array.from(range.getClientRects()).every(
                  (r) =>
                    r.left >= row.left &&
                    r.right <= row.right - 28 &&
                    r.top >= row.top &&
                    r.bottom <= row.bottom,
                );
              }),
            `option glyphs in ${selectPosition} at ${width}×${height}`,
          );
          await page.keyboard.press("End");
          await page.waitForFunction(() => document.activeElement?.textContent?.endsWith("39"));
          await page.keyboard.press("Enter");
          await select.waitFor({ state: "hidden" });
          assert.ok(
            (await page.getByRole("combobox", { name: "Quality select" }).innerText()).endsWith(
              "39",
            ),
          );
          await page.getByRole("button", { name: "Quality popover", exact: true }).click();
          const popover = page.locator('[data-slot="popover-content"]');
          await popover.waitFor();
          await visibleBounds(popover, width, height);
          await popover.evaluate((el) => {
            el.scrollTop = el.scrollHeight;
          });
          assert.ok(await popover.evaluate((el) => el.scrollTop > 0));
          await page.keyboard.press("Escape");
          await page.getByRole("button", { name: "Quality dropdown", exact: true }).click();
          const dropdown = page.locator('[data-slot="dropdown-menu-content"]');
          await dropdown.waitFor();
          await visibleBounds(dropdown, width, height);
          await page.waitForFunction(() =>
            ["menu", "menuitem"].includes(document.activeElement?.getAttribute("role")),
          );
          await page.keyboard.press("End");
          await page.waitForFunction(() => document.activeElement?.textContent?.endsWith("39"));
          await visibleBounds(dropdown.getByRole("menuitem").last(), width, height);
          await assertMenuGlyphsFit(dropdown.getByRole("menuitem").last());
          await page.keyboard.press("Escape");
          await page.getByTestId("quality-context-trigger").click({ button: "right" });
          const menu = page.getByRole("menu");
          await menu.waitFor();
          await visibleBounds(menu, width, height);
          await page.waitForFunction(() =>
            ["menu", "menuitem"].includes(document.activeElement?.getAttribute("role")),
          );
          await page.keyboard.press("End");
          await page.waitForFunction(() => document.activeElement?.textContent?.endsWith("39"));
          const last = page.getByRole("menuitem").last();
          await visibleBounds(last, width, height);
          await assertMenuGlyphsFit(last);
          assert.equal(await last.evaluate((el) => el === document.activeElement), true);
          await page.keyboard.press("Escape");
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        }
    },
  );
}
