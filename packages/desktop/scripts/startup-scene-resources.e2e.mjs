import assert from "node:assert/strict";
import { resolve } from "node:path";
import { open, unlink } from "node:fs/promises";
import { assertStartupSceneAlignment } from "./startup-scene.e2e.mjs";

async function seek(page, editor, seconds) {
  await editor.getByRole("button", { name: "暂停", exact: true }).click();
  await editor.getByRole("slider", { name: "动画时间" }).evaluate((input, seconds) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(
      input,
      String(seconds),
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, seconds);
  await page.waitForFunction((seconds) => {
    const canvas = document.querySelector('[data-testid="startup-scene-editor"] canvas');
    return (
      Math.abs(Number(canvas?.dataset.elapsed) - seconds) < 0.02 &&
      canvas?.dataset.mediaReady === "true"
    );
  }, seconds);
}

export async function runStartupSceneResourceTests({ t, page, navigate, artifacts }) {
  const editor = page.getByTestId("startup-scene-editor");
  const title = page.getByRole("combobox", { name: "启动动画", exact: true });
  const stored = () =>
    page.evaluate(
      () => JSON.parse(localStorage.getItem("startup-settings-fixture")).desktopStartupAnimation,
    );
  await t.test(
    "multiple subtitle tracks edit independently, render in their intervals and survive reload",
    async () => {
      await page.getByRole("button", { name: "制作动画", exact: true }).click();
      await editor.getByRole("button", { name: "添加副标题" }).click();
      await editor.getByRole("textbox", { name: "副标题内容", exact: true }).fill("第二行独立字幕");
      await editor.getByRole("spinbutton", { name: "X %" }).fill("24");
      await editor.getByRole("spinbutton", { name: "Y %" }).fill("45");
      await editor.getByRole("spinbutton", { name: "副标题字号" }).fill("30");
      await editor.getByRole("spinbutton", { name: "显示开始（秒）" }).fill("2");
      await editor.getByRole("spinbutton", { name: "显示结束（秒）" }).fill("6");
      await editor.getByRole("button", { name: "添加副标题" }).click();
      await editor.getByRole("textbox", { name: "副标题内容", exact: true }).fill("待删除");
      await editor.getByRole("button", { name: "删除当前副标题" }).click();
      await editor.getByRole("button", { name: "保存动画", exact: true }).click();
      await editor.getByRole("status").waitFor();
      const saved = (await stored()).scenes.aemeath;
      assert.equal(saved.subtitles.length, 2);
      assert.deepEqual(saved.subtitles[1], {
        id: saved.subtitles[1].id,
        text: "第二行独立字幕",
        position: { x: 24, y: 45 },
        size: 30,
        start: 2,
        end: 6,
      });
      assert.equal(saved.title, "LCode");
      await page.reload();
      await page.getByRole("button", { name: "制作动画", exact: true }).click();
      await editor.getByRole("combobox", { name: "选择副标题" }).click();
      await page.getByRole("option", { name: "副标题 2", exact: true }).click();
      assert.equal(
        await editor.getByRole("textbox", { name: "副标题内容", exact: true }).inputValue(),
        "第二行独立字幕",
      );
      assert.equal(await editor.getByRole("spinbutton", { name: "X %" }).inputValue(), "24");
      for (const [time, visible] of [
        [1, false],
        [4.7, true],
        [6.5, false],
      ]) {
        await seek(page, editor, time);
        assert.equal(
          JSON.parse(await editor.locator("canvas").getAttribute("data-subtitles")).includes(
            "第二行独立字幕",
          ),
          visible,
        );
      }
      await seek(page, editor, 4.7);
      await page.screenshot({ path: resolve(artifacts, "multiple-subtitles.png"), fullPage: true });
    },
  );
  await t.test(
    "custom artwork has continuous detailed contours and a left-to-right color reveal",
    async () => {
      await editor
        .getByLabel("自选背景图", { exact: true })
        .setInputFiles(resolve(import.meta.dirname, "../assets/startup-media/aemeath-artwork.jpg"));
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="startup-scene-editor"] canvas')?.dataset
            .resourceOrigin === "custom" &&
          Number(
            document.querySelector('[data-testid="startup-scene-editor"] canvas')?.dataset
              .contourPoints,
          ) > 1500,
      );
      await seek(page, editor, 3.95);
      await editor
        .getByTestId("startup-scene-stage")
        .screenshot({ path: resolve(artifacts, "custom-artwork-contours.png") });
      const count = Number(await editor.locator("canvas").getAttribute("data-contours"));
      const points = Number(await editor.locator("canvas").getAttribute("data-contour-points"));
      assert.ok(
        count > 10 && points / count > 3,
        `Connected contours required: ${count} paths, ${points} points`,
      );
      const colors = async () =>
        editor
          .locator("canvas")
          .evaluate((canvas) =>
            [0.25, 0.75].map((x) =>
              [
                ...canvas
                  .getContext("2d")
                  .getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height * 0.5), 1, 1)
                  .data,
              ].slice(0, 3),
            ),
          );
      await seek(page, editor, 4.25);
      const partial = await colors();
      await editor
        .getByTestId("startup-scene-stage")
        .screenshot({ path: resolve(artifacts, "custom-artwork-color-reveal.png") });
      await seek(page, editor, 4.7);
      const full = await colors();
      const difference = (a, b) => a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0);
      assert.ok(
        difference(partial[0], full[0]) < 12,
        `Left side must already be colored: ${partial[0]} vs ${full[0]}`,
      );
      assert.ok(
        difference(partial[1], full[1]) > 30,
        "Right side must still show linework before the reveal arrives",
      );
    },
  );
  await t.test(
    "custom MP4 decodes, follows seek/play/pause, persists and releases its decoder",
    async () => {
      await page.addInitScript(() => {
        window.sceneTestVideos = [];
        const create = document.createElement.bind(document);
        document.createElement = function (name, ...args) {
          const element = create(name, ...args);
          if (name === "video") window.sceneTestVideos.push(element);
          return element;
        };
      });
      await page.reload();
      await page.getByRole("button", { name: "制作动画", exact: true }).click();
      await editor
        .getByLabel("自选背景图", { exact: true })
        .setInputFiles(resolve(import.meta.dirname, "../assets/startup-media/baili-wallpaper.mp4"));
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="startup-scene-editor"] canvas')?.dataset
            .resourceKind === "video",
      );
      await seek(page, editor, 4.6);
      let native = await page.evaluate(() =>
        window.sceneTestVideos
          .filter((video) => video.getAttribute("src"))
          .map((video) => ({ time: video.currentTime, paused: video.paused, muted: video.muted })),
      );
      assert.equal(native.length, 1);
      assert.ok(Math.abs(native[0].time - 0.6) < 0.06);
      assert.equal(native[0].paused, true);
      assert.equal(native[0].muted, true);
      await editor.getByRole("button", { name: "播放", exact: true }).click();
      await page.waitForFunction(() =>
        window.sceneTestVideos.some((video) => !video.paused && video.currentTime > 0.85),
      );
      await editor.getByRole("button", { name: "暂停", exact: true }).click();
      assert.ok(await page.evaluate(() => window.sceneTestVideos.every((video) => video.paused)));
      await page.emulateMedia({ reducedMotion: "reduce" });
      await seek(page, editor, 6);
      assert.ok(
        await page.evaluate(() =>
          window.sceneTestVideos
            .filter((video) => video.getAttribute("src"))
            .every((video) => video.paused && video.currentTime < 0.04),
        ),
      );
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await editor.getByRole("button", { name: "保存动画", exact: true }).click();
      await editor.getByRole("status").waitFor();
      const id = (await stored()).scenes.aemeath.imageId;
      await page.reload();
      await page.getByRole("button", { name: "制作动画", exact: true }).click();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="startup-scene-editor"] canvas')?.dataset
            .resourceKind === "video",
      );
      assert.equal((await stored()).scenes.aemeath.imageId, id);
      await editor.getByLabel("自选背景图", { exact: true }).setInputFiles({
        name: "broken.mp4",
        mimeType: "video/mp4",
        buffer: Buffer.from("invalid video"),
      });
      await editor.getByRole("alert").waitFor();
      assert.equal((await stored()).scenes.aemeath.imageId, id);
      // Playwright 的内存上传有 50 MiB 上限；磁盘文件验证实际产品的 100 MiB 边界。
      const oversized = resolve(artifacts, "oversized-background.mp4");
      const handle = await open(oversized, "w");
      try {
        await handle.truncate(100 * 1024 * 1024 + 1);
      } finally {
        await handle.close();
      }
      try {
        await editor.getByLabel("自选背景图", { exact: true }).setInputFiles(oversized);
      } finally {
        await unlink(oversized);
      }
      await editor.getByRole("alert").waitFor();
      assert.equal((await stored()).scenes.aemeath.imageId, id);
      await page.getByRole("button", { name: "制作动画", exact: true }).click();
      assert.ok(
        await page.evaluate(() =>
          window.sceneTestVideos.every((video) => video.paused && !video.getAttribute("src")),
        ),
      );
    },
  );
  await t.test("Baili has its own editable template and cold-start readiness gate", async () => {
    const previous = (await stored()).scenes.aemeath;
    await title.click();
    await page.getByRole("option", { name: "白璃", exact: true }).click();
    await page.getByRole("button", { name: "制作动画", exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="startup-scene-editor"] canvas')?.dataset
          .resourceKind === "video",
    );
    await editor.getByRole("textbox", { name: "副标题内容", exact: true }).fill("白璃欢迎回来");
    await editor.getByRole("button", { name: "保存动画", exact: true }).click();
    await editor.getByRole("status").waitFor();
    const settings = await stored();
    assert.deepEqual(settings.scenes.aemeath, previous);
    assert.equal(settings.scenes.baili.subtitles[0].text, "白璃欢迎回来");
    await assertStartupSceneAlignment(editor);
    await editor
      .getByTestId("startup-scene-stage")
      .screenshot({ path: resolve(artifacts, "baili-editable.png") });
    const settingsUrl = page.url();
    await navigate("cinematic", false, "baili", { scenes: settings.scenes });
    await page.waitForFunction(
      () => document.querySelector("#loading")?.dataset.startupPhase === "hold",
    );
    assert.equal(await page.locator("#loading canvas").count(), 1);
    assert.equal(await page.locator("#loading video").count(), 0);
    assert.ok(
      Math.abs(Number(await page.locator("#loading canvas").getAttribute("data-elapsed")) - 7.9) <
        0.06,
    );
    assert.equal(await page.getByRole("textbox").isDisabled(), true);
    await page.evaluate(() => window.startupFixture.ready());
    await page.waitForFunction(() => !document.getElementById("loading"));
    await page.goto(settingsUrl);
    await page.getByTestId("startup-animation-settings").waitFor();
    await page.getByRole("button", { name: "制作动画", exact: true }).click();
    await editor.getByRole("button", { name: "恢复原版白璃" }).click();
    await editor.getByRole("status").waitFor();
    assert.equal((await stored()).scenes.baili, undefined);
    assert.deepEqual((await stored()).scenes.aemeath, previous);
    await page.getByRole("button", { name: "制作动画", exact: true }).click();
    await page.getByRole("button", { name: "预览动画", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#loading video")?.currentTime > 0.1);
    await page.keyboard.press("Escape");
  });
}
