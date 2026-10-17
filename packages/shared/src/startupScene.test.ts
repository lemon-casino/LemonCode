import assert from "node:assert/strict";
import { test } from "node:test";
import {
  startupSceneSchema,
  sceneTiming,
  sceneEase,
  sceneFragmentArrival,
  aemeathBlink,
  sceneResourceTime,
  sceneSubtitleVisible,
  startupSceneMediaKind,
} from "./startupScene.js";

test("品牌标题固定，旧默认副标题迁移，自定义副标题与排版保留", () => {
  const scene = startupSceneSchema.parse({
    title: "我的标题",
    subtitle: "幽灵来到…你身边～",
    titleSize: 72,
    titlePosition: { x: 20, y: 40 },
  });
  assert.equal(scene.title, "LCode");
  assert.equal(scene.subtitles[0]!.text, "欢迎回来…主人 ～");
  assert.equal(scene.titleSize, 72);
  assert.deepEqual(scene.titlePosition, { x: 20, y: 40 });
  assert.equal(startupSceneSchema.parse({}).subtitles[0]!.text, "欢迎回来…主人 ～");
  assert.equal(
    startupSceneSchema.parse({ subtitle: "自己的欢迎语" }).subtitles[0]!.text,
    "自己的欢迎语",
  );
  assert.equal("subtitle" in scene, false);
});

test("多副标题保留独立排版与时段，拒绝重复 id、超限及倒置区间", () => {
  const subtitles = [
    { id: "one", text: "欢迎", position: { x: 10, y: 40 }, size: 24, start: 1, end: 3 },
    { id: "two", text: "开始工作", position: { x: 20, y: 60 }, size: 18, start: 3 },
  ];
  const scene = startupSceneSchema.parse({ subtitle: "旧内容", subtitles });
  assert.deepEqual(scene.subtitles, subtitles);
  assert.equal(sceneSubtitleVisible(scene.subtitles[0]!, 0.9, 9), false);
  assert.equal(sceneSubtitleVisible(scene.subtitles[0]!, 1, 9), true);
  assert.equal(sceneSubtitleVisible(scene.subtitles[0]!, 3, 9), false);
  assert.equal(sceneSubtitleVisible(scene.subtitles[1]!, 8, 9), true);
  assert.equal(startupSceneSchema.parse({ subtitles: [] }).subtitles.length, 0);
  for (const invalid of [
    { subtitles: null },
    { subtitles: [subtitles[0]!, subtitles[0]!] },
    { subtitles: Array.from({ length: 9 }, (_, i) => ({ ...subtitles[0]!, id: String(i) })) },
    { subtitles: [{ ...subtitles[0]!, end: 0.5 }] },
  ])
    assert.equal(startupSceneSchema.safeParse(invalid).success, false);
});

test("动态背景格式和体积有界，媒体时间由着色开始派生且可循环 seek", () => {
  assert.equal(startupSceneMediaKind({ type: "video/mp4", size: 90 * 1024 * 1024 }), "video");
  assert.equal(startupSceneMediaKind({ type: "video/webm", size: 512 }), "video");
  assert.equal(startupSceneMediaKind({ type: "image/png", size: 512 }), "image");
  for (const file of [
    { type: "video/mp4", size: 101 * 1024 * 1024 },
    { type: "image/png", size: 11 * 1024 * 1024 },
    { type: "text/html", size: 10 },
  ])
    assert.throws(() => startupSceneMediaKind(file));
  const scene = startupSceneSchema.parse({});
  assert.equal(sceneResourceTime(scene, 3, 2), 0);
  assert.equal(sceneResourceTime(scene, 5, 2), 1);
  assert.equal(sceneResourceTime(scene, 7, 2), 1);
});

test("眨眼短闭慢开、周期复现，非有限时间保持睁眼", () => {
  assert.equal(aemeathBlink(0), 0);
  assert.equal(aemeathBlink(1.25) > 0, true);
  assert.equal(aemeathBlink(1.33), 1);
  assert.equal(aemeathBlink(1.6), 0);
  assert.ok(Math.abs(aemeathBlink(6.73) - aemeathBlink(1.33)) < 1e-8);
  assert.equal(aemeathBlink(Number.NaN), 0);
  assert.equal(aemeathBlink(-1), 0);
});

test("碎片先散开再从左到右汇聚，不在散开阶段提前生成轮廓", () => {
  assert.equal(sceneFragmentArrival("cubicInOut", 0, 0), 0);
  assert.equal(sceneFragmentArrival("cubicInOut", 0, 1), 0);
  assert.ok(
    sceneFragmentArrival("cubicInOut", 0.5, 0.1) > sceneFragmentArrival("cubicInOut", 0.5, 0.9),
  );
  assert.equal(sceneFragmentArrival("cubicInOut", 1, 1), 1);
});

test("模板默认九秒，等待和交接从阶段时长派生", () => {
  const scene = startupSceneSchema.parse({});
  assert.deepEqual(sceneTiming(scene), {
    duration: 9,
    holdAt: 7.9,
    transitionStart: 8,
    transitionEnd: 8.95,
  });
  const next = startupSceneSchema.parse({ ...scene, durations: { ...scene.durations, trace: 3 } });
  assert.equal(sceneTiming(next).holdAt, 8.9);
  assert.equal(sceneTiming(next).duration, 10);
});

test("缓动端点保持一致，回弹允许超调，未知及越界配置拒绝", () => {
  for (const easing of [
    "linear",
    "quadraticOut",
    "cubicInOut",
    "sineInOut",
    "exponentialOut",
    "backOut",
    "bounceOut",
  ] as const) {
    assert.equal(sceneEase(easing, 0), 0);
    assert.ok(Math.abs(sceneEase(easing, 1) - 1) < 1e-10);
  }
  assert.ok(sceneEase("backOut", 0.7) > 1);
  for (const invalid of [
    { title: "x".repeat(41) },
    { accent: "url(https://example.invalid)" },
    { easing: "script" },
    { titlePosition: { x: 101, y: 20 } },
    { durations: { pulse: -1 } },
  ])
    assert.equal(startupSceneSchema.safeParse(invalid).success, false);
});
