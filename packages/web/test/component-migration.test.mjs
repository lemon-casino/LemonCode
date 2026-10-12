import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";
import {
  runAutomationComposerCases,
  runShareConfirmationCases,
  runSyncCheckboxCases,
  runWhiteboardSliderCases,
} from "./component-migration-cases.mjs";

// 控件迁移首版（specs/frontend-ui-component-migration.md）的定向浏览器验收：
// C03 远端同步复选框、C04 分享确认、C05 白板 Slider 适配器、C06 自动化 Instructions 输入。
// 断言的是迁移完成后的目标契约；组件迁移落地前这些子测试失败是预期。
test(
  "component migration: sync checkboxes, share confirmation, slider adapter and composer textarea",
  { timeout: 240_000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const origin = `http://127.0.0.1:${port}`;
    const artifacts = fileURLToPath(new URL("../../../.lcode/component-quality/", import.meta.url));
    await mkdir(artifacts, { recursive: true });
    const load = async (fixture, search = "") => {
      // 60s：dev server 对 fixture 的首次按需转换（含共享包源码链）在本机可能超过
      // setDefaultTimeout(10_000) 的默认值；只放宽导航等待，不放宽任何行为断言。
      await page.goto(`${origin}/test/fixtures/${fixture}${search}`, { timeout: 60_000 });
      await page.getByTestId("fixture-ready").waitFor();
    };

    await runSyncCheckboxCases({ t, page, load });
    await runShareConfirmationCases({ t, page, load, visibleBounds });
    await runWhiteboardSliderCases({ t, page, load });
    await runAutomationComposerCases({ t, page, load });
    assert.deepEqual(errors, []);

    async function visibleBounds(locator, width, height) {
      const box = await locator.boundingBox();
      assert.ok(
        box &&
          box.x >= -1 &&
          box.y >= -1 &&
          box.x + box.width <= width + 1 &&
          box.y + box.height <= height + 1,
        JSON.stringify(box),
      );
    }
  },
);
