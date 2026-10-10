import assert from "node:assert/strict";
export async function runWelcomeLayoutQualityCases({ t, page, browser, fixture, artifacts }) {
  await t.test(
    "production timeline empty state and dock never mask the logo or greeting",
    async () => {
      await page.evaluate(() => localStorage.setItem("lcode-theme", "sepia-light"));
      for (const english of [false, true])
        for (const font of [14, 20]) {
          for (const [width, height] of [
            [827, 547],
            [873, 583],
            [1280, 720],
            [320, 568],
            [844, 390],
          ]) {
            await page.setViewportSize({ width, height });
            await page.goto(
              `${fixture}?timeline&font=${font}${english ? "&english" : ""}${width < 400 ? "&compact" : ""}`,
            );
            await page.locator("[data-v4-draft-greeting]").waitFor();
            const bounds = await page.evaluate(() => {
              const rect = (selector) =>
                document.querySelector(selector).getBoundingClientRect().toJSON();
              return {
                logo: rect("[data-v4-draft-logo-frame]"),
                greeting: rect("[data-v4-draft-greeting]"),
                dock: rect("[data-v4-composer-dock]"),
                viewport: rect("[data-v4-timeline-scroll]"),
                welcome: rect("[data-v4-welcome-region]"),
                width: document.documentElement.scrollWidth,
              };
            });
            assert.ok(bounds.logo.top >= 0 && bounds.logo.bottom <= bounds.greeting.top);
            assert.ok(bounds.greeting.top - bounds.logo.bottom <= 9, JSON.stringify(bounds));
            assert.ok(bounds.greeting.bottom <= bounds.dock.top, JSON.stringify(bounds));
            assert.ok(
              Math.abs(bounds.dock.bottom - (bounds.viewport.top + bounds.viewport.height)) <= 1,
              JSON.stringify(bounds),
            );
            if (bounds.greeting.bottom - bounds.logo.top + 32 <= bounds.welcome.height) {
              const center = (bounds.logo.top + bounds.greeting.bottom) / 2;
              assert.ok(
                Math.abs(center - (bounds.welcome.top + bounds.welcome.height / 2)) <= 2,
                JSON.stringify(bounds),
              );
            }
            assert.ok(bounds.greeting.bottom <= height, JSON.stringify(bounds));
            assert.ok(bounds.width <= width);
            if (!english && font === 14 && width === 827) {
              await page.screenshot({ path: `${artifacts}/timeline-827x547.png` });
            }
          }
        }
      const stressPage = await page.context().newPage();
      const stressErrors = [];
      stressPage.on("pageerror", (error) => stressErrors.push(error.message));
      stressPage.setDefaultTimeout(10_000);
      try {
        await stressPage.setViewportSize({ width: 320, height: 400 });
        await stressPage.goto(`${fixture}?timeline&font=20&compact&english&stress`);
        await stressPage.locator("[data-v4-draft-greeting]").waitFor();
        const input = stressPage.getByRole("textbox", { name: "Composer", exact: true });
        await input.fill("retained draft after resizing");
        await stressPage.locator("[data-v4-welcome-region]").evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        const stressBounds = await stressPage.evaluate(() => ({
          greeting: document
            .querySelector("[data-v4-draft-greeting]")
            .getBoundingClientRect()
            .toJSON(),
          dock: document.querySelector("[data-v4-composer-dock]").getBoundingClientRect().toJSON(),
          height: innerHeight,
        }));
        assert.ok(
          stressBounds.greeting.bottom <= stressBounds.dock.top,
          JSON.stringify(stressBounds),
        );
        assert.ok(
          Math.abs(stressBounds.dock.bottom - stressBounds.height) <= 1,
          JSON.stringify(stressBounds),
        );
        await stressPage.setViewportSize({ width: 844, height: 390 });
        assert.equal(await input.inputValue(), "retained draft after resizing");
        assert.deepEqual(stressErrors, []);
      } finally {
        await stressPage.close();
      }
    },
  );

  await t.test("touch mobile welcome keeps large readable type in both orientations", async () => {
    const touch = await browser.newContext({ hasTouch: true, isMobile: true });
    try {
      const phone = await touch.newPage();
      for (const font of [14, 20]) {
        await phone.setViewportSize({ width: 390, height: 844 });
        await phone.goto(`${fixture}?timeline&compact&font=${font}`);
        const greeting = phone.locator("[data-v4-draft-greeting]");
        await greeting.waitFor();
        for (const [width, height] of [
          [390, 844],
          [844, 390],
        ]) {
          await phone.setViewportSize({ width, height });
          assert.equal(
            await greeting.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
            font + 10,
          );
          const bounds = await greeting.boundingBox();
          assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= height, JSON.stringify(bounds));
        }
      }
    } finally {
      await touch.close();
    }
  });
}
