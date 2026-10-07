import assert from "node:assert/strict";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "conversation timeline converges after long history hydration and remount",
  { timeout: 120_000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const width of [1280, 390]) {
      await t.test(`${width}px`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 800 } });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        await page.goto(
          `http://127.0.0.1:${port}/test/fixtures/conversation-send.html?timelineDepth`,
        );
        const timeline = page.locator('[data-v4-timeline-scroll="true"]');
        await timeline.waitFor();
        await page.waitForFunction(
          () =>
            document
              .querySelector('[data-v4-timeline-scroll="true"]')
              ?.getAttribute("data-window-row-count") === "336",
        );
        for (const operation of ["resizeRows", "switchSession", "retry"]) {
          await page.evaluate((action) => globalThis.__timelineDepthFixture[action](), operation);
          await page.waitForFunction(
            () =>
              document
                .querySelector('[data-v4-timeline-scroll="true"]')
                ?.getAttribute("data-render-unit-count") === "84",
          );
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
        }
        assert.deepEqual(errors, []);
        assert.ok(await page.locator('[data-v4-turn-unit="true"]').count());
        await page.close();
      });
    }
  },
);
