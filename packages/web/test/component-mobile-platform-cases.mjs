import assert from "node:assert/strict";

export async function runMobilePlatformQualityCases({
  t,
  browser,
  page,
  origin,
  artifacts,
  visibleBounds,
}) {
  await t.test(
    "touch mobile input floor, orientation and keyboard viewport preserve the draft",
    async () => {
      const context = await browser.newContext({
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
        viewport: { width: 390, height: 844 },
      });
      const mobile = await context.newPage();
      for (const width of [320, 390])
        for (const font of [12, 14, 20]) {
          await mobile.setViewportSize({ width, height: 844 });
          await mobile.goto(`${origin}/test/fixtures/theme-quality.html?controls&font=${font}`);
          const input = mobile.getByRole("spinbutton", { name: "Quality number" });
          await input.waitFor();
          assert.equal(
            await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
            Math.max(16, font),
          );
          assert.equal(
            await mobile.locator("html").evaluate((el) => getComputedStyle(el).fontSize),
            "16px",
          );
          await input.fill("17");
          await mobile.setViewportSize({ width, height: 400 });
          assert.equal(await input.inputValue(), "17");
          assert.ok(
            await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          );
          await mobile.getByRole("button", { name: "Production workflow", exact: true }).tap();
          await visibleBounds(mobile.getByRole("dialog"), width, 400);
          await visibleBounds(mobile.locator('[data-slot="dialog-footer"]'), width, 400);
          const last = mobile.getByRole("dialog").getByRole("textbox").last();
          await last.fill("retained mobile draft");
          await mobile.setViewportSize({ width: 844, height: 390 });
          assert.equal(await last.inputValue(), "retained mobile draft");
          await visibleBounds(mobile.locator('[data-slot="dialog-footer"]'), 844, 390);
          await mobile.getByRole("button", { name: "取消", exact: true }).tap();
          await mobile.getByRole("dialog").waitFor({ state: "hidden" });
        }
      await mobile.screenshot({ path: `${artifacts}/touch-landscape.png` });
      await context.close();
    },
  );

  await t.test(
    "production frame projects Windows/macOS/Linux backgrounds, clipping and modal bounds",
    async () => {
      await page.setViewportSize({ width: 1280, height: 720 });
      for (const platform of ["windows", "mac", "linux"]) {
        await page.goto(`${origin}/test/fixtures/theme-quality.html?controls&platform=${platform}`);
        const frame = page.locator('[data-desktop-window-frame="true"]');
        await frame.waitFor();
        await visibleBounds(frame, 1280, 720);
        const style = await frame.evaluate((el) => {
          const computed = getComputedStyle(el);
          const canvas = document.createElement("canvas");
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = computed.backgroundColor;
          ctx.fillRect(0, 0, 1, 1);
          return {
            backgroundAlpha: ctx.getImageData(0, 0, 1, 1).data[3],
            clip: computed.clipPath,
            root: getComputedStyle(document.documentElement).backgroundColor,
          };
        });
        assert.equal(style.root, "rgba(0, 0, 0, 0)");
        assert.equal(style.backgroundAlpha < 255, platform === "mac");
        if (platform === "linux") {
          assert.ok(style.clip.includes("16px"));
          await page.locator("html").evaluate((el) => el.classList.add("window-maximized"));
          assert.equal(await frame.evaluate((el) => getComputedStyle(el).borderRadius), "0px");
        }
        await page.getByRole("button", { name: "Long dialog", exact: true }).click();
        await visibleBounds(page.getByRole("dialog"), 1280, 720);
        await page.screenshot({ path: `${artifacts}/platform-${platform}.png` });
        await page.keyboard.press("Escape");
      }
    },
  );
}
