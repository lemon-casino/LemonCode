import assert from "node:assert/strict";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";

async function backgroundPixel(page, project) {
  const png = await project.screenshot();
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    return [...context.getImageData(image.width - 24, image.height - 24, 1, 1).data].slice(0, 3);
  }, png.toString("base64"));
}

export async function runWallpaperTests({ t, page, hasMedia, artifacts }) {
  const project = page.getByTestId("wallpaper-project");
  const openProject = () => page.getByRole("button", { name: "返回项目", exact: true }).click();
  const openSettings = () =>
    page.getByRole("button", { name: "打开外观设置", exact: true }).click();
  const choose = async (name) => {
    await page.getByRole("combobox", { name: "壁纸选择" }).click();
    await page.getByRole("option", { name, exact: true }).click();
    // 等待现有串行存储发布已提交选择，避免 reload 抢在写入完成前发生。
    await page.waitForFunction(
      (name) => document.querySelector('[aria-label="壁纸选择"]')?.textContent.includes(name),
      name,
    );
  };
  await t.test(
    "wallpaper applies to nested project surfaces and survives reload; invalid input preserves it",
    async () => {
      const input = page.locator("[data-testid=wallpaper-settings] input[type=file]");
      const png = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 360;
        const context = canvas.getContext("2d");
        context.fillStyle = "#315b82";
        context.fillRect(0, 0, 640, 360);
        return canvas.toDataURL("image/png").split(",")[1];
      });
      await input.setInputFiles({
        name: "wallpaper.png",
        mimeType: "image/png",
        buffer: Buffer.from(png, "base64"),
      });
      await openProject();
      await project.getByTestId("wallpaper-image").waitFor();
      await page.waitForFunction(() =>
        Boolean(
          document.querySelector("[data-testid=wallpaper-project] [data-wallpaper-active=true]"),
        ),
      );
      const colored = await backgroundPixel(page, project);
      await page
        .getByRole("textbox", { name: "Wallpaper project input" })
        .fill("wallpaper does not intercept input");
      await page.screenshot({ path: resolve(artifacts, "wallpaper-custom-project.png") });
      await page.reload();
      await page.getByRole("combobox", { name: "壁纸选择" }).waitFor();
      assert.match(await page.getByRole("combobox", { name: "壁纸选择" }).innerText(), /自选图片/);
      for (const file of [
        { name: "broken.png", mimeType: "image/png", buffer: Buffer.from("not an image") },
        { name: "large.png", mimeType: "image/png", buffer: Buffer.alloc(10 * 1024 * 1024 + 1) },
      ]) {
        await input.setInputFiles(file);
        await page.getByRole("alert").waitFor();
        await openProject();
        await project.getByTestId("wallpaper-image").waitFor();
        await openSettings();
      }
      await choose("关闭");
      await openProject();
      await page.waitForFunction(
        () => !document.querySelector("[data-testid=wallpaper-project] img"),
      );
      const plain = await backgroundPixel(page, project);
      assert.ok(
        colored.reduce((sum, value, i) => sum + Math.abs(value - plain[i]), 0) > 40,
        `Wallpaper must be visible through nested surfaces: ${colored} vs ${plain}`,
      );
      await openSettings();
    },
  );
  await t.test(
    "built-in wallpapers are selectable and render in the project; settings has no preview decoder",
    { skip: !hasMedia },
    async () => {
      await page.getByRole("combobox", { name: "壁纸选择" }).click();
      assert.equal(
        await page.getByRole("option", { name: "龙娘（静态）", exact: true }).count(),
        0,
      );
      assert.equal(await page.getByRole("option").count(), 4);
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("video,img").count(), 0);
      await choose("白璃（动态）");
      await openProject();
      await page.waitForFunction(
        () => document.querySelector("[data-testid=wallpaper-video]")?.currentTime > 0.1,
      );
      assert.deepEqual(
        await project.locator("video").evaluate((video) => [video.muted, video.loop]),
        [true, true],
      );
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.waitForFunction(
        () => document.querySelector("[data-testid=wallpaper-video]")?.paused === true,
      );
      await page.screenshot({ path: resolve(artifacts, "wallpaper-baili.png") });
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await openSettings();
      await page.waitForFunction(() => !document.querySelector("[data-testid=wallpaper-video]"));
      await openProject();
      await page.waitForFunction(
        () => document.querySelector("[data-testid=wallpaper-video]")?.currentTime > 0.1,
      );
      await page.evaluate(() => document.documentElement.classList.add("dark"));
      await page.screenshot({ path: resolve(artifacts, "wallpaper-dark.png") });
      await page.evaluate(() => document.documentElement.classList.remove("dark"));
      await openSettings();
      await choose("爱弥斯（动态）");
      await page.reload();
      await page.waitForFunction(() =>
        document.querySelector('[aria-label="壁纸选择"]')?.textContent.includes("爱弥斯"),
      );
      assert.match(await page.getByRole("combobox", { name: "壁纸选择" }).innerText(), /爱弥斯/);
      await openProject();
      await page.waitForFunction(
        () => document.querySelector("[data-testid=wallpaper-aemeath]")?.dataset.ready === "true",
      );
      const portrait = project.getByTestId("wallpaper-aemeath");
      const closed = await page.waitForFunction(() => {
        const canvas = document.querySelector("[data-testid=wallpaper-aemeath]");
        if (Number(canvas?.dataset.blink) < 0.999) return false;
        canvas.closedPixels = canvas
          .getContext("2d")
          .getImageData(0, 0, canvas.width, canvas.height).data;
        return canvas.toDataURL();
      });
      const closedPng = await closed.jsonValue();
      await writeFile(
        resolve(artifacts, "aemeath-wallpaper-closed.png"),
        Buffer.from(closedPng.split(",")[1], "base64"),
      );
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.waitForFunction(
        () => document.querySelector("[data-testid=wallpaper-aemeath]")?.dataset.blink === "0.000",
      );
      const stillTime = await portrait.getAttribute("data-elapsed");
      const comparison = await portrait.evaluate((canvas) => {
        // 直接比较同一 Canvas 的原始像素，避免 PNG 解码颜色量化干扰区域判断。
        const before = canvas.closedPixels;
        const after = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
        const scale = Math.max(canvas.width / 1536, canvas.height / 1024);
        const dx = (canvas.width - 1536 * scale) / 2,
          dy = (canvas.height - 1024 * scale) / 2;
        const delta = [0, 0, 0];
        const outsideChanges = [];
        let outsideMax = 0;
        for (let y = 0; y < canvas.height; y++)
          for (let x = 0; x < canvas.width; x++) {
            const sx = (x - dx) / scale,
              sy = (y - dy) / scale;
            const region =
              sx > 520 && sx < 720 && sy > 290 && sy < 490
                ? 0
                : sx > 750 && sx < 955 && sy > 330 && sy < 530
                  ? 1
                  : 2;
            const offset = (y * canvas.width + x) * 4;
            if (
              region === 2 &&
              outsideChanges.length < 12 &&
              [0, 1, 2].some((channel) => before[offset + channel] !== after[offset + channel])
            )
              outsideChanges.push({
                x,
                y,
                sx,
                sy,
                before: Array.from(before.subarray(offset, offset + 3)),
                after: Array.from(after.subarray(offset, offset + 3)),
              });
            for (let channel = 0; channel < 3; channel++) {
              const difference = Math.abs(before[offset + channel] - after[offset + channel]);
              delta[region] += difference;
              if (region === 2) outsideMax = Math.max(outsideMax, difference);
            }
          }
        return {
          delta,
          outsideMax,
          outsideChanges,
          pixels: canvas.width * canvas.height,
          png: canvas.toDataURL(),
        };
      });
      assert.ok(
        comparison.delta[0] > 10000 && comparison.delta[1] > 10000,
        `Both eyes must visibly blink: ${comparison.delta}`,
      );
      // GPU 读回后重采样会在少量位置产生 1/255 舍入；禁止更大的色差或区域外可见变化。
      assert.ok(
        comparison.outsideMax <= 1 && comparison.delta[2] < comparison.pixels * 0.0001,
        `Blink must preserve artwork outside the eyes: ${JSON.stringify(comparison.outsideChanges)}`,
      );
      await writeFile(
        resolve(artifacts, "aemeath-wallpaper-open.png"),
        Buffer.from(comparison.png.split(",")[1], "base64"),
      );
      assert.equal(await portrait.getAttribute("data-elapsed"), stillTime);
      assert.equal(await project.locator("video").count(), 0);
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await openSettings();
      assert.equal(await page.getByTestId("wallpaper-aemeath").count(), 0);
      await choose("关闭");
    },
  );
  await t.test("Web restoration does not open wallpaper storage or request media", async () => {
    const requests = [];
    const track = (request) => {
      if (request.url().includes("/startup-media/")) requests.push(request.url());
    };
    page.on("request", track);
    await page.addInitScript(() => {
      window.wallpaperStorageReads = 0;
      window.startupSceneStorageReads = 0;
      const original = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (name, ...args) {
        if (name === "lcode-local-appearance") window.wallpaperStorageReads++;
        if (name === "lcode-startup-images") window.startupSceneStorageReads++;
        return original.call(this, name, ...args);
      };
    });
    await page.goto(`${page.url().split("?")[0]}?ready=1&settings=1&web=1&locale=zh-CN`);
    await page.getByTestId("startup-animation-settings").waitFor();
    assert.equal(await page.getByTestId("wallpaper-settings").count(), 0);
    assert.equal(await page.evaluate(() => window.wallpaperStorageReads), 0);
    assert.equal(await page.evaluate(() => window.startupSceneStorageReads), 0);
    assert.deepEqual(requests, []);
    page.off("request", track);
  });
}
