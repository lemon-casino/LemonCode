import assert from "node:assert/strict";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";

export async function assertStartupSceneAlignment(editor) {
  const boxes = await Promise.all([
    editor.getByRole("combobox", { name: "缓动曲线", exact: true }).boundingBox(),
    editor.getByRole("img", { name: "缓动曲线预览", exact: true }).boundingBox(),
    editor.getByRole("spinbutton", { name: "背景缩放", exact: true }).boundingBox(),
    editor.getByLabel("线条颜色", { exact: true }).boundingBox(),
    editor.getByLabel("自选背景图", { exact: true }).boundingBox(),
    editor.getByRole("button", { name: "保存动画", exact: true }).boundingBox(),
  ]);
  const [easing, curve, scale, color, file, save] = boxes;
  assert.ok(boxes.every(Boolean));
  assert.ok(curve.x >= easing.x + easing.width, "曲线预览应在缓动选择器右侧");
  assert.ok(
    Math.abs(easing.y + easing.height / 2 - curve.y - curve.height / 2) < 1,
    "缓动选择器与预览应垂直居中对齐",
  );
  assert.ok(
    Math.abs(scale.height - color.height) < 1,
    `颜色与数值控件应等高：${scale.height} vs ${color.height}`,
  );
  assert.ok(
    Math.abs(file.y + file.height - save.y - save.height) < 1,
    "文件选择与操作按钮应底部对齐",
  );
}

export async function runStartupSceneColdTest({ t, page, navigate, artifacts }) {
  await t.test(
    "editable canvas waits for project readiness and releases its drawing loop",
    async () => {
      await page.setViewportSize({ width: 1200, height: 800 });
      await navigate("cinematic", false, "aemeath");
      await page.waitForFunction(
        () => document.querySelector("#loading canvas")?.dataset.phase === "display",
      );
      assert.equal(await page.locator("#loading .avatar,#loading .dial,#loading video").count(), 0);
      await page.screenshot({ path: resolve(artifacts, "aemeath-display.png") });
      const closed = await page.waitForFunction(() => {
        const canvas = document.querySelector("#loading canvas");
        return Number(canvas?.dataset.blink) > 0.999 && canvas.toDataURL();
      });
      await writeFile(
        resolve(artifacts, "aemeath-startup-blink.png"),
        Buffer.from((await closed.jsonValue()).split(",")[1], "base64"),
      );
      await page.waitForFunction(
        () => document.querySelector("#loading")?.dataset.startupPhase === "hold",
      );
      const time = await page.locator("#loading canvas").getAttribute("data-elapsed");
      assert.ok(Math.abs(Number(time) - 7.9) < 0.05);
      assert.equal(await page.getByRole("textbox").isDisabled(), true);
      await page.evaluate(() => window.startupFixture.ready());
      await page.waitForFunction(() => !document.getElementById("loading"));
      assert.equal(await page.locator("canvas").count(), 0);
      await page.getByRole("textbox").fill("Canvas never bypasses project admission");
    },
  );
}

export async function runStartupSceneEditorTest({ t, page, artifacts }) {
  await t.test(
    "scene editor drafts, drag positions, easing, image validation, save and ASAR preview",
    async () => {
      const animation = page.getByRole("combobox", { name: "启动动画", exact: true });
      await animation.click();
      await page.getByRole("option", { name: "爱弥斯", exact: true }).click();
      await page.getByRole("button", { name: "制作动画", exact: true }).click();
      const editor = page.getByTestId("startup-scene-editor");
      await editor.locator("canvas").waitFor();
      const headline = editor.getByRole("textbox", { name: "标题内容", exact: true });
      assert.equal(await headline.inputValue(), "LCode");
      assert.equal(await headline.evaluate((input) => input.readOnly), true);
      assert.equal(
        await editor.getByRole("textbox", { name: "副标题内容", exact: true }).inputValue(),
        "欢迎回来…主人 ～",
      );
      await editor.getByRole("textbox", { name: "副标题内容", exact: true }).fill("欢迎回来");
      assert.notEqual(
        await page.evaluate(
          () =>
            JSON.parse(localStorage.getItem("startup-settings-fixture")).desktopStartupAnimation
              .scenes?.aemeath?.subtitles[0]?.text,
        ),
        "欢迎回来",
      );
      const handle = editor.getByRole("button", { name: "拖动文字位置" });
      await handle.scrollIntoViewIfNeeded();
      const box = await handle.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 35, box.y + box.height / 2 - 20, { steps: 5 });
      await page.mouse.up();
      assert.ok(Number(await editor.getByRole("spinbutton", { name: "X %" }).inputValue()) > 7);
      await editor.getByRole("spinbutton", { name: "X %" }).fill("12");
      await editor.getByRole("spinbutton", { name: "Y %" }).fill("80");
      await editor.getByRole("spinbutton", { name: "标题字号", exact: true }).fill("64");
      await editor.getByRole("spinbutton", { name: "脉冲加载", exact: true }).fill("0.6");
      await editor.getByRole("combobox", { name: "调整元素", exact: true }).click();
      await page.getByRole("option", { name: "背景图位置", exact: true }).click();
      await editor.getByRole("spinbutton", { name: "X %" }).fill("60");
      await editor.getByRole("spinbutton", { name: "背景缩放", exact: true }).fill("1.2");
      await editor.getByRole("combobox", { name: "缓动曲线", exact: true }).click();
      await page.getByRole("option", { name: "回弹 · 超调", exact: true }).click();
      const input = editor.getByLabel("自选背景图", { exact: true });
      await input.setInputFiles({
        name: "broken.png",
        mimeType: "image/png",
        buffer: Buffer.from("broken"),
      });
      await editor.getByRole("alert").waitFor();
      const png = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 96;
        canvas.height = 64;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#964bc0";
        ctx.fillRect(0, 0, 96, 64);
        return canvas.toDataURL("image/png").split(",")[1];
      });
      await input.setInputFiles({
        name: "custom.png",
        mimeType: "image/png",
        buffer: Buffer.from(png, "base64"),
      });
      await editor.getByRole("button", { name: "保存动画", exact: true }).click();
      await editor.getByRole("status").waitFor();
      const saved = await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("startup-settings-fixture")).desktopStartupAnimation
            .scenes.aemeath,
      );
      assert.equal(saved.title, "LCode");
      assert.equal(saved.subtitles[0].text, "欢迎回来");
      assert.deepEqual(saved.titlePosition, { x: 12, y: 80 });
      assert.equal(saved.titleSize, 64);
      assert.deepEqual(saved.imagePosition, { x: 60, y: 50 });
      assert.equal(saved.imageScale, 1.2);
      assert.equal(saved.easing, "backOut");
      assert.equal(saved.durations.pulse, 0.6);
      assert.equal(saved.image, "custom");
      assert.equal(JSON.stringify(saved).includes("base64"), false);
      // 设置提交失败不能替换旧配置仍引用的图片。
      const replacement = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 96;
        canvas.height = 64;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#2244bb";
        ctx.fillRect(0, 0, 96, 64);
        return canvas.toDataURL("image/png").split(",")[1];
      });
      await input.setInputFiles({
        name: "replacement.png",
        mimeType: "image/png",
        buffer: Buffer.from(replacement, "base64"),
      });
      await page.evaluate(() => {
        window.startupSettingsFail = true;
      });
      await editor.getByRole("button", { name: "保存动画", exact: true }).click();
      await editor.getByRole("alert").waitFor();
      assert.equal(
        await page.evaluate(
          () =>
            JSON.parse(localStorage.getItem("startup-settings-fixture")).desktopStartupAnimation
              .scenes.aemeath.imageId,
        ),
        saved.imageId,
      );
      await page.reload();
      await page.getByRole("button", { name: "制作动画", exact: true }).click();
      await editor.getByRole("textbox", { name: "标题内容", exact: true }).waitFor();
      assert.equal(
        await editor.getByRole("textbox", { name: "标题内容", exact: true }).inputValue(),
        "LCode",
      );
      await editor.getByRole("button", { name: "全窗预览", exact: true }).click();
      await page.waitForFunction(() => Boolean(document.querySelector("#loading canvas")));
      await page.waitForFunction(
        () => document.querySelector("#loading canvas")?.dataset.phase === "display",
      );
      const pixel = await page
        .locator("#loading canvas")
        .evaluate((canvas) => [
          ...canvas
            .getContext("2d")
            .getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data,
        ]);
      assert.ok(
        pixel[0] > 100 && pixel[1] < 100 && pixel[2] > 130,
        `Saved image must survive failed settings commit: ${pixel}`,
      );
      await page.screenshot({ path: resolve(artifacts, "aemeath-custom-preview.png") });
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#loading").count(), 0);
      await editor.getByRole("button", { name: "恢复模板", exact: true }).click();
      assert.equal(
        await editor.getByRole("textbox", { name: "标题内容", exact: true }).inputValue(),
        "LCode",
      );
      for (const name of ["脉冲加载", "碎片散开", "线稿汇聚", "彩色生成", "彩色展示", "中央收拢"])
        await editor.getByRole("spinbutton", { name, exact: true }).fill("0.3");
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="startup-scene-clock"]')?.textContent ===
          "1.8 / 1.8s",
      );
      await editor.getByRole("button", { name: "恢复模板", exact: true }).click();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="startup-scene-editor"] canvas')?.dataset.elapsed ===
          "4.700",
      );
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await editor.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
        true,
      );
      await page.screenshot({
        path: resolve(artifacts, "aemeath-editor-mobile.png"),
        fullPage: true,
      });
      await page.setViewportSize({ width: 1200, height: 800 });
      await editor.getByRole("button", { name: "保存动画", exact: true }).click();
      await editor.getByRole("status").waitFor();
      await page.setViewportSize({ width: 1200, height: 1800 });
      await assertStartupSceneAlignment(editor);
      await page.evaluate(() => {
        document.documentElement.style.setProperty("--ui-font-size", "20px");
        document.documentElement.classList.add("dark");
      });
      await assertStartupSceneAlignment(editor);
      await editor
        .getByTestId("startup-scene-fields")
        .screenshot({ path: resolve(artifacts, "startup-editor-fields-dark.png") });
      await editor
        .getByTestId("startup-scene-media-controls")
        .screenshot({ path: resolve(artifacts, "startup-editor-actions-dark.png") });
      await page.evaluate(() => {
        document.documentElement.style.removeProperty("--ui-font-size");
        document.documentElement.classList.remove("dark");
      });
      await page.getByTestId("startup-scene-stage").scrollIntoViewIfNeeded();
      await page.screenshot({ path: resolve(artifacts, "aemeath-editor.png"), fullPage: true });
      await page.setViewportSize({ width: 1200, height: 800 });
      await page.getByRole("button", { name: "制作动画", exact: true }).click();
      assert.equal(await page.locator("canvas").count(), 0);
    },
  );
}
