import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

for (const [width, locale, theme] of [
  [1280, "zh-CN", "dark"],
  [390, "en-US", "light"],
]) {
  test(
    `compact strategy settings, collapse and contextual help (${width}, ${locale})`,
    { timeout: 90_000 },
    async (t) => {
      const { browser, port } = await startWorkflowProgressBrowser(t);
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        isMobile: width < 640,
        hasTouch: width < 640,
      });
      page.setDefaultTimeout(10_000);
      await mkdir(".tmp/simple-routing-ui", { recursive: true });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const visit = async (seed) => {
        await page.goto(
          `http://127.0.0.1:${port}/test/fixtures/provider-routing.html?locale=${locale}&theme=${theme}&seed=${seed}`,
        );
        await page.getByTestId("provider-routing-editor").waitFor();
      };
      const editor = page.getByTestId("provider-routing-editor");
      const choose = async (strategy) => {
        await editor.getByTestId("routing-strategy").click();
        await page.getByTestId(`routing-option-${strategy}`).click();
      };
      const save = async (strategy) => {
        const before = await page.evaluate(() => window.__routingFixture.saves);
        await editor.getByTestId("routing-save").click();
        await page.waitForFunction(
          ({ strategy, before }) =>
            (window.__routingFixture.policy?.strategy ?? "legacy") === strategy &&
            window.__routingFixture.saves > before,
          { strategy, before },
        );
      };
      const noAdvanced = async () => {
        assert.equal(await page.getByTestId("api-key-routing-batch").count(), 0);
        assert.equal(await editor.getByRole("spinbutton").count(), 0);
        assert.equal(await editor.getByRole("switch").count(), 0);
        assert.equal(await editor.getByRole("combobox").count(), 1);
        assert.deepEqual(
          await page.evaluate(() => [
            window.__routingFixture.pageReads,
            window.__routingFixture.metadataSaves,
            window.__routingFixture.secretReads,
          ]),
          [0, 0, 0],
        );
      };
      await visit("default");
      await noAdvanced();
      await editor.getByTestId("routing-strategy").click();
      assert.equal(await page.getByRole("option").count(), 5);
      assert.equal(await page.getByTestId("routing-option-legacy").count(), 0);
      await page.keyboard.press("Escape");
      assert.equal(
        (await editor.getByTestId("routing-strategy").textContent()).trim(),
        locale === "zh-CN" ? "可靠优选" : "Reliable first",
      );
      await choose("reliable-first");
      const toggle = editor.getByTestId("routing-toggle");
      await toggle.click();
      assert.equal(await toggle.getAttribute("aria-expanded"), "false");
      assert.equal(await editor.getByTestId("routing-strategy").count(), 0);
      assert.equal(await page.evaluate(() => window.__routingFixture.saves), 0);
      await toggle.focus();
      await page.keyboard.press("Enter");
      assert.equal(await toggle.getAttribute("aria-expanded"), "true");
      assert.equal(
        (await editor.getByTestId("routing-strategy").textContent()).trim(),
        locale === "zh-CN" ? "可靠优选" : "Reliable first",
      );
      for (const strategy of [
        "reliable-first",
        "primary-backup",
        "primary-backup",
        "share-rotation",
        "headroom-balance",
        "expiry-first",
      ]) {
        await choose(strategy);
        const help = editor.getByTestId("routing-help");
        if (width >= 640) await help.hover();
        else await help.tap();
        const tip = page.getByTestId("routing-help-content");
        await tip.waitFor();
        assert.equal(await tip.getAttribute("data-strategy"), strategy);
        const expected =
          locale === "zh-CN"
            ? {
                "reliable-first": "近期请求结果",
                "primary-backup": "现有连接顺序",
                "share-rotation": "默认等份轮转",
                "headroom-balance": "预计压力",
                "expiry-first": "实际请求",
              }
            : {
                "reliable-first": "recent results",
                "primary-backup": "existing order",
                "share-rotation": "Rotate equally",
                "headroom-balance": "projected pressure",
                "expiry-first": "actual requests",
              };
        assert.ok((await tip.textContent()).includes(expected[strategy]));
        if (strategy === "expiry-first")
          await page.screenshot({
            path: `.tmp/simple-routing-ui/${width}-${locale}-help.png`,
            animations: "disabled",
            fullPage: true,
          });
        const box = await tip.boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
        await page.keyboard.press("Escape");
        await save(strategy);
        assert.deepEqual(await page.evaluate(() => window.__routingFixture.policy), {
          version: 1,
          strategy,
        });
      }
      await editor.getByTestId("routing-help").focus();
      await page.getByTestId("routing-help-content").waitFor();
      await page.keyboard.press("Escape");
      if (width >= 640) {
        const boxes = await Promise.all(
          [toggle, editor.getByTestId("routing-strategy"), editor.getByTestId("routing-save")].map(
            (item) => item.boundingBox(),
          ),
        );
        assert.ok(
          Math.max(...boxes.map((b) => b.y + b.height / 2)) -
            Math.min(...boxes.map((b) => b.y + b.height / 2)) <
            3,
        );
        assert.ok(boxes[1].width <= 200, `Selector should be compact: ${boxes[1].width}`);
      }
      await mkdir(".tmp/simple-routing-ui", { recursive: true });
      await page.screenshot({
        path: `.tmp/simple-routing-ui/${width}-${locale}.png`,
        fullPage: true,
      });
      await editor.screenshot({ path: `.tmp/simple-routing-ui/${width}-${locale}-panel.png` });
      await toggle.click();
      await page.screenshot({
        path: `.tmp/simple-routing-ui/${width}-${locale}-collapsed.png`,
        fullPage: true,
      });
      await toggle.click();
      await choose("reliable-first");
      await save("reliable-first");
      await visit("advanced");
      const metadata = await page.evaluate(() => window.__routingFixture.keyMetadata);
      await choose("expiry-first");
      await page.evaluate(() => window.__routingFixture.bumpRevision());
      await editor.getByTestId("routing-save").click();
      await editor.getByRole("alert").waitFor();
      assert.equal(await page.evaluate(() => window.__routingFixture.saves), 0);
      await editor.getByRole("alert").getByRole("button").click();
      await choose("primary-backup");
      await save("primary-backup");
      assert.deepEqual(await page.evaluate(() => window.__routingFixture.policy), {
        version: 1,
        strategy: "primary-backup",
      });
      assert.deepEqual(await page.evaluate(() => window.__routingFixture.keyMetadata), metadata);
      await noAdvanced();
      await visit("empty");
      await noAdvanced();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      assert.deepEqual(errors, []);
    },
  );
}
