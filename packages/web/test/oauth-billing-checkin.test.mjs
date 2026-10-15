import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";
import { verifyModelMenuCompact } from "./model-menu-compact-cases.mjs";

test(
  "model columns align, unknown price is blank, and exact identity survives long names",
  { timeout: 120_000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const [width, locale, theme, nested] of [
      [1280, "zh-CN", "light", false],
      [390, "en-US", "dark", false],
      [1280, "en-US", "dark", true],
      [390, "zh-CN", "light", true],
    ]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(
        `http://127.0.0.1:${port}/test/fixtures/model-billing-menu.html?locale=${locale}&theme=${theme}${nested ? "&nested=1" : ""}`,
      );
      if (nested) await page.addStyleTag({ content: "html { font-size: 20px; }" });
      await page.getByRole("button", { name: "Models", exact: true }).click();
      if (nested && width >= 768) {
        await page.getByRole("menuitem", { name: "OAuth", exact: true }).focus();
        await page.keyboard.press("ArrowRight");
      }
      const rows = page.getByRole("menuitemradio");
      await rows.first().waitFor();
      assert.equal(await rows.count(), 6);
      await verifyModelMenuCompact(rows);
      const bounds = await rows.first().boundingBox();
      assert.ok(
        bounds.x >= 0 && bounds.x + bounds.width <= width,
        `menu outside viewport: ${JSON.stringify(bounds)}`,
      );
      assert.ok(
        await rows
          .nth(1)
          .locator("[title]")
          .first()
          .evaluate((el) => el.getBoundingClientRect().width > 20),
        "long name retains visible space",
      );
      const positions = await rows.evaluateAll((elements) =>
        elements.map((e) => {
          const capability = e
            .querySelector("[data-model-capability-column]")
            .getBoundingClientRect();
          const billing = e.querySelector("[data-model-billing-column]").getBoundingClientRect();
          return { capability: capability.x, billing: billing.x };
        }),
      );
      for (const p of positions) {
        assert.ok(Math.abs(p.capability - positions[0].capability) < 1);
        assert.ok(Math.abs(p.billing - positions[0].billing) < 1);
      }
      for (const row of [rows.nth(0), rows.nth(1)]) {
        const gap = await row.evaluate((element) => {
          const vision = element.querySelector('[data-model-input-capability="vision"]');
          const billing = element.querySelector("[data-model-billing]");
          return {
            actual: billing.getBoundingClientRect().left - vision.getBoundingClientRect().right,
            expected: Number.parseFloat(getComputedStyle(element).columnGap),
          };
        });
        assert.ok(
          Math.abs(gap.actual - gap.expected) <= 1 && gap.actual <= 12,
          `billing should follow vision closely: ${JSON.stringify(gap)}`,
        );
      }
      assert.match(await rows.nth(0).innerText(), /0\.25×/);
      assert.match(await rows.nth(1).innerText(), /0\.71×/);
      assert.equal(await rows.nth(3).locator("[data-model-billing-column]").innerText(), "");
      assert.match(await rows.nth(5).innerText(), /1\.5×/);
      assert.doesNotMatch(await rows.nth(5).innerText(), /免费|Free/);
      assert.ok(await rows.nth(1).locator("[title]").first().getAttribute("title"));
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
      );
      await mkdir(".tmp/oauth-billing-checkin", { recursive: true });
      await page.screenshot({ path: `.tmp/oauth-billing-checkin/menu-${width}-${nested}.png` });
      await rows.nth(1).click();
      assert.equal(await page.getByTestId("selected-model").innerText(), "exact-long");
      assert.deepEqual(errors, []);
      await page.close();
    }
  },
);

test(
  "compact model menus remove both right-side gaps with scrolling, promotions and locks",
  { timeout: 120_000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const [width, locale, theme, nested, promotion, locked] of [
      [1280, "zh-CN", "light", true, false, false],
      [1280, "en-US", "dark", true, true, false],
      [390, "zh-CN", "light", true, false, false],
      [320, "en-US", "dark", true, true, false],
      [1280, "zh-CN", "light", true, false, true],
      [1280, "en-US", "dark", false, false, false],
    ]) {
      const page = await browser.newPage({ viewport: { width, height: 500 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        await page.goto(
          `http://127.0.0.1:${port}/test/fixtures/model-billing-menu.html?compact=1&locale=${locale}&theme=${theme}${nested ? "&nested=1" : ""}${promotion ? "&promotion=1" : ""}${locked ? "&locked=1" : ""}`,
        );
        await page.evaluate(() =>
          document.documentElement.style.setProperty("--ui-font-size", "20px"),
        );
        await page.getByRole("button", { name: "Models", exact: true }).click();
        if (nested && width >= 768) {
          await page.getByRole("menuitem", { name: "OAuth", exact: true }).focus();
          await page.keyboard.press("ArrowRight");
        }
        const rows = page.locator('[data-slot="dropdown-menu-radio-group"] > [data-testid]');
        await rows.first().waitFor();
        assert.equal(await rows.count(), promotion ? 19 : 18);
        await verifyModelMenuCompact(rows);
        const menu = page.locator(
          `[data-slot="${nested && width >= 768 ? "dropdown-menu-sub-content" : "dropdown-menu-content"}"]`,
        );
        assert.ok(
          await rows.evaluateAll((elements) =>
            elements.every(
              (element) => element.querySelector("[title]").getBoundingClientRect().width > 20,
            ),
          ),
          "model names retain visible space",
        );
        assert.ok(await menu.evaluate((element) => element.scrollHeight > element.clientHeight));
        assert.ok(
          await rows
            .locator("[data-model-billing]")
            .evaluateAll((elements) =>
              elements.every(
                (element) =>
                  element.scrollWidth <= element.clientWidth + 1 &&
                  element.lastElementChild.scrollWidth <= element.lastElementChild.clientWidth + 1,
              ),
            ),
        );
        const bounds = await menu.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, JSON.stringify(bounds));
        if (!promotion && width === 1280)
          assert.ok(bounds.width < 440, `menu still too wide: ${bounds.width}`);
        if (locked)
          assert.equal(await rows.nth(1).locator("[data-model-status-column] svg").count(), 2);
        if (promotion)
          assert.equal(
            await rows.last().locator("[data-model-billing] s").innerText(),
            "123.4567×",
          );
        if (process.env.LCODE_TEST_SCREENSHOT_DIR) {
          await mkdir(process.env.LCODE_TEST_SCREENSHOT_DIR, { recursive: true });
          await menu.screenshot({
            path: `${process.env.LCODE_TEST_SCREENSHOT_DIR}/menu-${width}-${locale}-${promotion}-${locked}-${nested}.png`,
          });
        }
        await rows.last().click();
        assert.equal(
          await page.getByTestId("selected-model").innerText(),
          promotion ? "promotion" : "compact-17",
        );
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    }
  },
);

test(
  "account check-in actions precede deletion and batch results and automatic settings stay per account",
  { timeout: 120_000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const width of [1280, 390]) {
      const english = width === 390;
      const text = english
        ? {
            login: "Authorization",
            start: "Start authorization",
            code: "Authorization code",
            complete: "Complete authorization",
            accounts: "Connected accounts",
            remove: "Remove account",
            all: "Check in all",
            auto: "Automatic check-in",
            oneAuto: "Automatically check in Fixture Account 1",
          }
        : {
            login: "登录授权",
            start: "开始授权",
            code: "授权码",
            complete: "完成授权",
            accounts: "已登录账号",
            remove: "删除账号",
            all: "一键签到",
            auto: "自动签到",
            oneAuto: "为 Fixture Account 1 自动签到",
          };
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(
        `http://127.0.0.1:${port}/test/fixtures/provider-accounts.html?checkin=1&theme=light${english ? "&locale=en-US" : ""}`,
      );
      await page.getByTestId("oauth-channel-fixture").click();
      for (let i = 0; i < 2; i++) {
        await page.getByRole("tab", { name: text.login, exact: true }).click();
        await page.getByRole("button", { name: text.start, exact: true }).click();
        await page.getByLabel(text.code, { exact: true }).fill(`fixture-${i}`);
        await page.getByRole("button", { name: text.complete, exact: true }).click();
      }
      await page.getByRole("tab", { name: text.accounts, exact: true }).click();
      const card = page.getByTestId("oauth-account-account-1");
      assert.equal(
        await card.evaluate((el, removeLabel) => {
          const buttons = [...el.querySelectorAll("button")];
          return (
            buttons.indexOf(el.querySelector('[data-testid="oauth-checkin-account-1"]')) <
            buttons.findIndex((b) => b.textContent === removeLabel)
          );
        }, text.remove),
        true,
      );
      await page.getByTestId("oauth-checkin-account-1").click();
      await card
        .getByTestId("oauth-checkin-result-account-1")
        .getByText(english ? /25 credits/ : /25 积分/)
        .waitFor();
      await page
        .getByTestId("oauth-checkin-header")
        .getByRole("button", { name: text.all })
        .click();
      await page
        .getByTestId("oauth-checkin-result-account-2")
        .getByText(english ? /vendor's own app/ : /供应商原应用/)
        .waitFor();
      await page
        .getByTestId("oauth-checkin-header")
        .getByRole("switch", { name: text.auto, exact: true })
        .click();
      await page.waitForFunction(() =>
        window.__providerAccounts.accounts.every((a) => a.checkin?.automatic),
      );
      await card.getByRole("switch", { name: text.oneAuto, exact: true }).click();
      await page.waitForFunction(
        () =>
          !window.__providerAccounts.accounts[0].checkin.automatic &&
          window.__providerAccounts.accounts[1].checkin.automatic,
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
      );
      await page.close();
    }
  },
);
