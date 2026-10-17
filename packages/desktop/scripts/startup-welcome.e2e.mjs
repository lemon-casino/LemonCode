import assert from "node:assert/strict";
import { resolve } from "node:path";

export async function runStartupWelcomeTests({ t, page, origin, artifacts }) {
  const open = async (preset, mode = "cinematic", template = {}) => {
    const query = new URLSearchParams({
      welcome: "1",
      locale: "zh-CN",
      startupAnimation: JSON.stringify({
        enabled: true,
        launchId: crypto.randomUUID(),
        settings: { mode, preset, volume: 0.25, ...template },
      }),
    });
    await page.goto(`${origin}?${query}`);
    await page.waitForFunction(() => Boolean(window.welcomeFixture));
  };
  for (const preset of ["baili", "aemeath", "custom"]) {
    await t.test(
      `${preset} fades the real welcome card over retained artwork and waits for Root`,
      async () => {
        await open(preset);
        await page.waitForFunction(
          () => document.documentElement.classList.contains("lcode-startup-welcome"),
          undefined,
          { timeout: 25000 },
        );
        const enter = page.getByRole("button", { name: "进入", exact: true });
        await enter.waitFor();
        await page.waitForFunction(() => {
          const card = document.querySelector("[data-welcome-card]");
          return card && Number(getComputedStyle(card).opacity) >= 0.999;
        });
        assert.equal(await page.getByRole("button", { name: "跳过动画 · Esc" }).isVisible(), false);
        assert.equal(await enter.evaluate((element) => element === document.activeElement), true);
        assert.equal(await page.locator("#loading").count(), 1);
        assert.equal(await page.locator("#root").evaluate((element) => element.inert), false);
        assert.equal(
          await enter.evaluate(
            (element) => getComputedStyle(element.closest("[data-welcome-card]")).webkitAppRegion,
          ),
          "no-drag",
        );
        assert.equal(
          await page
            .locator("#loading")
            .evaluate((element) => getComputedStyle(element).webkitAppRegion),
          "no-drag",
        );
        if (preset === "baili") {
          const video = page.locator("#loading video");
          const before = await video.evaluate((element) => ({
            paused: element.paused,
            muted: element.muted,
            volume: element.volume,
            time: element.currentTime,
          }));
          assert.equal(before.paused, false);
          assert.equal(before.muted, false);
          assert.equal(before.volume, 0.25);
          await page.waitForFunction(
            (time) => document.querySelector("#loading video").currentTime > time + 0.15,
            before.time,
          );
          await video.evaluate((element) => {
            element.currentTime = element.duration - 0.2;
          });
          await page.waitForFunction(
            () => document.querySelector("#loading video").currentTime < 2,
          );
          assert.equal(await enter.isVisible(), true);
        } else {
          const canvas = page.locator("#loading canvas");
          const before = Number(await canvas.getAttribute("data-resource-clock"));
          await page.waitForFunction(
            (time) =>
              Number(document.querySelector("#loading canvas").dataset.resourceClock) > time + 0.15,
            before,
          );
          assert.equal(await canvas.getAttribute("data-phase"), "display");
          if (preset === "aemeath")
            await page.waitForFunction(
              () => Number(document.querySelector("#loading canvas").dataset.blink) > 0.99,
            );
        }
        if (preset === "custom") {
          assert.equal(
            await page.locator("#loading canvas").getAttribute("data-resource-origin"),
            "builtin",
          );
          assert.equal(await page.locator("#loading canvas").getAttribute("data-blink"), "0.000");
        }
        await page.screenshot({ path: resolve(artifacts, `${preset}-welcome.png`) });
        assert.equal(
          await enter.evaluate((element) => element === document.activeElement),
          true,
          "持续播放时应保留进入按钮焦点",
        );
        await page.evaluate(() => {
          window.welcomeShortcutCount = 0;
          window.addEventListener("keydown", (event) => {
            if (event.key === "F8") window.welcomeShortcutCount++;
          });
        });
        await page.keyboard.press("F8");
        assert.equal(await page.evaluate(() => window.welcomeShortcutCount), 0);
        await page.keyboard.press("Tab");
        await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "取消");
        assert.equal(
          await page
            .getByRole("button", { name: "取消", exact: true })
            .evaluate((element) => element === document.activeElement),
          true,
          JSON.stringify(
            await page.evaluate(() => ({
              active: document.activeElement?.outerHTML,
              phase: document.querySelector("#loading")?.dataset.startupPhase,
            })),
          ),
        );
        await page.keyboard.press("Shift+Tab");
        await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "进入");
        if (preset === "aemeath") await page.keyboard.press("Enter");
        else await enter.click();
        await page.waitForFunction(() => window.welcomeFixture.reasons.length === 1);
        await page.keyboard.press("Enter");
        assert.deepEqual(await page.evaluate(() => window.welcomeFixture.reasons), ["skip"]);
        await page.evaluate(() => window.welcomeFixture.finishPreparation());
        await page
          .getByRole("textbox", { name: "Welcome project input" })
          .waitFor({ state: "attached" });
        assert.equal(await page.getByRole("textbox").isDisabled(), true);
        assert.equal(await page.locator("#loading").count(), 1);
        await page.evaluate(() => window.welcomeFixture.finishPreparation());
        await page.waitForFunction(() => !document.getElementById("loading"));
        assert.equal(await page.locator("#root").evaluate((element) => element.inert), false);
        assert.equal(
          await page.evaluate(() =>
            document.documentElement.classList.contains("lcode-startup-welcome"),
          ),
          false,
        );
        await page.getByRole("textbox").fill("Root admitted input");
      },
    );
  }
  await t.test(
    "custom video background keeps decoding while the welcome awaits confirmation",
    async () => {
      const imageId = await page.evaluate(async () => {
        const media = await fetch("/startup-media/baili-wallpaper.mp4").then((response) =>
          response.blob(),
        );
        const { saveStartupSceneImage } = await import("/src/startup/sceneImages.ts");
        return saveStartupSceneImage(media);
      });
      await open("custom", "cinematic", { scenes: { custom: { image: "custom", imageId } } });
      await page.waitForFunction(() =>
        document.documentElement.classList.contains("lcode-startup-welcome"),
      );
      const before = await page.locator("#loading canvas").getAttribute("data-resource-time");
      await page.waitForFunction(
        (time) =>
          Number(document.querySelector("#loading canvas").dataset.resourceTime) >
          Number(time) + 0.2,
        before,
      );
      assert.equal(await page.locator("#loading canvas").getAttribute("data-phase"), "display");
      await page.getByRole("button", { name: "进入", exact: true }).click();
      await page.evaluate(() => window.welcomeFixture.finishPreparation());
      await page.getByRole("textbox").waitFor({ state: "attached" });
      assert.equal(await page.getByRole("textbox").isDisabled(), true);
      await page.evaluate(() => window.welcomeFixture.finishPreparation());
      await page.waitForFunction(() => !document.getElementById("loading"));
    },
  );
  await t.test(
    "cancel on the composited welcome preserves its reason and still waits for admission",
    async () => {
      await open("custom");
      await page.waitForFunction(() =>
        document.documentElement.classList.contains("lcode-startup-welcome"),
      );
      await page.getByRole("button", { name: "取消", exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.welcomeFixture.reasons), ["cancel"]);
      await page.evaluate(() => window.welcomeFixture.finishPreparation());
      await page
        .getByRole("textbox", { name: "Welcome project input" })
        .waitFor({ state: "attached" });
      assert.equal(await page.getByRole("textbox").isDisabled(), true);
      assert.equal(await page.locator("#loading").count(), 1);
      await page.evaluate(() => window.welcomeFixture.finishPreparation());
      await page.waitForFunction(() => !document.getElementById("loading"));
    },
  );
  await t.test(
    "welcome skip, reduced motion, errors and original mode expose the existing card",
    async () => {
      await open("custom");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "取消", exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.welcomeFixture.reasons), ["cancel"]);
      for (const mode of ["simple", "off"]) {
        await open("custom", mode);
        await page.waitForFunction(() => !document.getElementById("loading"));
        await page.getByRole("button", { name: "进入", exact: true }).waitFor();
      }
      await page.emulateMedia({ reducedMotion: "reduce" });
      await open("custom");
      await page.waitForFunction(() => !document.getElementById("loading"));
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await open("custom");
      await page.evaluate(() => window.welcomeAttention());
      await page.waitForFunction(() => !document.getElementById("loading"));
      await page.getByRole("alert").waitFor();
    },
  );
}

export async function runCustomStartupEditorTest({ t, page, artifacts }) {
  await t.test(
    "custom template persists independently and keeps the mandatory LCode title",
    async () => {
      const stored = () =>
        page.evaluate(
          () =>
            JSON.parse(localStorage.getItem("startup-settings-fixture")).desktopStartupAnimation,
        );
      const before = await stored();
      await page.getByRole("combobox", { name: "启动动画", exact: true }).click();
      await page.getByRole("option", { name: "自定义", exact: true }).click();
      await page.getByRole("button", { name: "制作动画", exact: true }).click();
      const editor = page.getByTestId("startup-scene-editor");
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="startup-scene-editor"] canvas')?.dataset
            .resourceKind === "image",
      );
      assert.equal(
        await editor.getByRole("textbox", { name: "标题内容", exact: true }).inputValue(),
        "LCode",
      );
      assert.equal(
        await editor
          .getByRole("textbox", { name: "标题内容", exact: true })
          .evaluate((element) => element.readOnly),
        true,
      );
      await editor.getByRole("textbox", { name: "副标题内容", exact: true }).fill("我的开机动画");
      await editor.getByRole("spinbutton", { name: "标题字号", exact: true }).fill("68");
      await editor.getByRole("button", { name: "保存动画", exact: true }).click();
      await editor.getByRole("status").waitFor();
      const saved = await stored();
      assert.equal(saved.preset, "custom");
      assert.equal(saved.scenes.custom.title, "LCode");
      assert.equal(saved.scenes.custom.subtitles[0].text, "我的开机动画");
      assert.deepEqual(saved.scenes.aemeath, before.scenes.aemeath);
      assert.deepEqual(saved.scenes.baili, before.scenes.baili);
      await editor
        .getByTestId("startup-scene-stage")
        .screenshot({ path: resolve(artifacts, "custom-editor.png") });
      await page.reload();
      await page.getByRole("button", { name: "制作动画", exact: true }).click();
      assert.equal(
        await editor.getByRole("textbox", { name: "副标题内容", exact: true }).inputValue(),
        "我的开机动画",
      );
      await page.getByRole("button", { name: "制作动画", exact: true }).click();
    },
  );
}
