import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "organize submenu keeps the parent anchored and flips only itself at the window edge",
  { timeout: 120000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const scenario of [
      { width: 1280, height: 900, english: false, right: false, font: 14 },
      { width: 1280, height: 900, english: true, right: true, font: 20 },
      { width: 800, height: 430, english: false, right: false, font: 20 },
    ]) {
      const page = await browser.newPage({
        viewport: { width: scenario.width, height: scenario.height },
      });
      page.setDefaultTimeout(10000);
      page.setDefaultNavigationTimeout(45000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(
        `http://127.0.0.1:${port}/test/fixtures/sidebar-organization.html?theme=sepia-light${scenario.english ? "&english" : ""}`,
      );
      const trigger = page.getByTestId("sidebar-organize");
      await trigger.waitFor();
      await page.evaluate(({ right, width, font }) => {
        document.documentElement.style.setProperty("--ui-font-size", `${font}px`);
        if (right)
          document.querySelector('[data-testid="sidebar"]').parentElement.style.marginLeft =
            `${width - 320}px`;
      }, scenario);
      const composer = page.getByRole("textbox", { name: "Composer" });
      await composer.focus();
      await trigger.hover();
      const root = page.getByRole("menu", {
        name: scenario.english ? "Organize sidebar" : "整理侧边栏",
        exact: true,
      });
      const filter = page.getByRole("menuitem", {
        name: scenario.english ? "Filter and sort" : "筛选和排序",
        exact: true,
      });
      await filter.waitFor();
      await root.evaluate((node) =>
        Promise.all(
          (node.closest('[data-slot="popover-content"]') ?? node)
            .getAnimations({ subtree: true })
            .map((animation) => animation.finished.catch(() => {})),
        ),
      );
      const before = await root.boundingBox();
      for (let pass = 0; pass < 3; pass++) {
        await page
          .getByRole("menuitem", { name: scenario.english ? "Focus" : "专注", exact: true })
          .hover();
        const focusPanel = page.locator("[data-sidebar-focus-panel]");
        await focusPanel.waitFor();
        await focusPanel.evaluate((node) =>
          Promise.all(
            node
              .closest('[data-slot="popover-content"]')
              .getAnimations({ subtree: true })
              .map((animation) => animation.finished.catch(() => {})),
          ),
        );
        const focused = await root.boundingBox();
        for (const key of ["x", "y", "width", "height"])
          assert.ok(Math.abs(focused[key] - before[key]) <= 1, `focus submenu moved parent ${key}`);
        assert.equal(await focusPanel.getByRole("menuitemradio").count(), 4);
        assert.equal(
          await focusPanel.getByRole("menuitemradio", { checked: true }).innerText(),
          scenario.english ? "All" : "全部",
        );
        await filter.hover();
        await focusPanel.waitFor({ state: "hidden" });
        const child = page.locator("[data-sidebar-sort-panel]");
        await child.waitFor();
        await child.evaluate((node) =>
          Promise.all(
            (node.closest('[data-slot="popover-content"]') ?? node)
              .getAnimations({ subtree: true })
              .map((animation) => animation.finished.catch(() => {})),
          ),
        );
        const after = await root.boundingBox();
        for (const key of ["x", "y", "width", "height"])
          assert.ok(
            Math.abs(after[key] - before[key]) <= 1,
            `${key} moved when opening the submenu: ${JSON.stringify({ before, after, scenario })}`,
          );
        const childBox = await child.boundingBox();
        if (scenario.right && pass === 0)
          await page.screenshot({
            path: ".artifacts/sidebar-organization/organize-submenu-right.png",
            animations: "disabled",
          });
        if (scenario.right)
          assert.ok(
            childBox.x + childBox.width <= before.x + 2,
            `only the submenu flips left: ${JSON.stringify({ before, childBox, side: await child.locator("..").getAttribute("data-side") })}`,
          );
        else
          assert.ok(childBox.x >= before.x + before.width - 6, "submenu opens beside its parent");
        assert.ok(childBox.x >= 0 && childBox.x + childBox.width <= scenario.width);
        assert.ok(childBox.y >= 0 && childBox.y + childBox.height <= scenario.height);
        await child.getByRole("menuitem").first().hover();
        assert.equal(
          await composer.evaluate((node) => node === document.activeElement),
          true,
          "hover must preserve composer focus",
        );
        if (pass === 0 && !scenario.right && scenario.height === 900) {
          await mkdir(".artifacts/sidebar-organization", { recursive: true });
          await page.screenshot({
            path: ".artifacts/sidebar-organization/organize-submenu-fixed.png",
            animations: "disabled",
          });
        }
        await root
          .getByRole("menuitem", {
            name: scenario.english ? "New section" : "新建分区",
            exact: true,
          })
          .hover();
        await child.waitFor({ state: "hidden" });
      }
      const focusEntry = page.getByRole("menuitem", {
        name: scenario.english ? "Focus" : "专注",
        exact: true,
      });
      await focusEntry.focus();
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(() =>
        Boolean(document.activeElement?.closest("[data-sidebar-focus-panel]")),
      );
      await page.keyboard.press("ArrowUp");
      assert.equal(
        await page.evaluate(() => document.activeElement.textContent.trim()),
        scenario.english ? "Chats" : "会话",
      );
      await page.keyboard.press("Home");
      assert.equal(
        await page.evaluate(() => document.activeElement.textContent.trim()),
        scenario.english ? "All" : "全部",
      );
      await page.keyboard.press("Escape");
      assert.equal(await focusEntry.evaluate((node) => node === document.activeElement), true);
      await filter.focus();
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(() =>
        Boolean(document.activeElement?.closest("[data-sidebar-sort-panel]")),
      );
      await page.keyboard.press("Escape");
      assert.equal(await filter.evaluate((node) => node === document.activeElement), true);
      await root.waitFor();
      await page.keyboard.press("Escape");
      await root.waitFor({ state: "hidden" });
      assert.deepEqual(errors, []);
      await page.close();
    }
  },
);
