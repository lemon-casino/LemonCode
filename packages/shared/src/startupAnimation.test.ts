import assert from "node:assert/strict";
import { test } from "node:test";
import { appSettingsPatchSchema, appSettingsSchema } from "./validationAppSettings.js";
import {
  startupAnimationSettingsSchema,
  startupAnimationBootstrapSchema,
  getStartupAnimationChoice,
  startupAnimationChoicePatch,
  STARTUP_ANIMATION_CHOICES,
  getStartupScene,
} from "./startupAnimation.js";

test("旧模板单向迁移到爱弥斯，两个预设模板独立且不双写旧字段", () => {
  const settings = startupAnimationSettingsSchema.parse({
    preset: "baili",
    scene: { subtitle: "原爱弥斯" },
    scenes: { baili: { subtitle: "白璃" } },
  });
  assert.equal(settings.scenes?.aemeath?.subtitles[0]!.text, "原爱弥斯");
  assert.equal(settings.scenes?.baili?.subtitles[0]!.text, "白璃");
  assert.equal("scene" in settings, false);
  assert.deepEqual(startupAnimationSettingsSchema.parse(settings), settings);
  assert.equal(
    startupAnimationSettingsSchema.safeParse({ scene: {}, scenes: null }).success,
    false,
  );
});

test("旧设置默认官方动画并静音；设置读取与写入使用同一动画校验", () => {
  assert.deepEqual(startupAnimationSettingsSchema.parse({}), {
    mode: "simple",
    volume: 0,
    preset: "baili",
  });
  assert.equal(appSettingsSchema.parse({}).desktopStartupAnimation, undefined);
  const config = { mode: "cinematic", volume: 0.25, preset: "baili" };
  assert.deepEqual(
    appSettingsPatchSchema.parse({ desktopStartupAnimation: config }).desktopStartupAnimation,
    config,
  );
  for (const config of [
    { mode: "unknown" },
    { preset: "../custom" },
    { volume: -1 },
    { volume: 2 },
    { volume: NaN },
    { volume: Infinity },
  ]) {
    assert.equal(
      appSettingsPatchSchema.safeParse({ desktopStartupAnimation: config }).success,
      false,
    );
  }
});

test("单个启动动画选择器兼容旧配置，切换时只修改 mode/preset", () => {
  const previous = startupAnimationSettingsSchema.parse({
    mode: "cinematic",
    preset: "baili",
    volume: 0.5,
  });
  assert.deepEqual(STARTUP_ANIMATION_CHOICES, ["official", "baili", "aemeath", "custom", "off"]);
  for (const choice of ["official", "baili", "aemeath", "custom", "off"] as const) {
    const next = startupAnimationSettingsSchema.parse({
      ...previous,
      ...startupAnimationChoicePatch(choice),
    });
    assert.equal(getStartupAnimationChoice(next), choice);
    assert.equal(next.volume, 0.5);
  }
  assert.equal(getStartupAnimationChoice(startupAnimationSettingsSchema.parse({})), "official");
  assert.equal(
    getStartupAnimationChoice(startupAnimationSettingsSchema.parse({ mode: "cinematic" })),
    "official",
  );
});

test("自定义使用独立模板，主标题规范为 LCode，缺省模板无需角色配置", () => {
  const settings = startupAnimationSettingsSchema.parse({
    mode: "cinematic",
    preset: "custom",
    scenes: { custom: { title: "其它标题", titleSize: 72 }, aemeath: { titleSize: 32 } },
  });
  assert.equal(getStartupScene(settings)?.title, "LCode");
  assert.equal(getStartupScene(settings)?.titleSize, 72);
  assert.equal(settings.scenes?.aemeath?.titleSize, 32);
  assert.equal(
    getStartupScene(startupAnimationSettingsSchema.parse({ preset: "custom" }))?.title,
    "LCode",
  );
});

test("已删除及未指定的旧视频配置回到官方动画，保留音量", () => {
  for (const preset of [undefined, "dragon"]) {
    const input = { mode: "cinematic", volume: 0.5, ...(preset ? { preset } : {}) };
    for (const schema of [appSettingsSchema, appSettingsPatchSchema]) {
      assert.deepEqual(schema.parse({ desktopStartupAnimation: input }).desktopStartupAnimation, {
        mode: "simple",
        volume: 0.5,
        preset: "baili",
      });
    }
  }
  for (const mode of ["simple", "off"] as const) {
    assert.deepEqual(
      startupAnimationSettingsSchema.parse({ mode, preset: "dragon", volume: 0.5 }),
      {
        mode,
        preset: "baili",
        volume: 0.5,
      },
    );
  }
});

test("启动快照仅允许类型化设置和一次性启动标识", () => {
  assert.equal(
    startupAnimationBootstrapSchema.safeParse({ enabled: true, launchId: "launch", settings: {} })
      .success,
    true,
  );
  assert.equal(
    startupAnimationBootstrapSchema.safeParse({ enabled: true, launchId: "", settings: {} })
      .success,
    false,
  );
  assert.equal(
    startupAnimationBootstrapSchema.safeParse({
      enabled: true,
      launchId: "launch",
      settings: {},
      path: "arbitrary",
    }).success,
    false,
  );
});
