import assert from "node:assert/strict";
import { test } from "node:test";
import { StartupAnimationState } from "../src/renderer/src/startup/animationState.js";
import { StartupSceneClock } from "../src/renderer/src/startup/sceneClock.js";

test("窗口出现或 React commit 不能当作工作台就绪；等待点仅在真实就绪后继续", () => {
  const state = new StartupAnimationState("cinematic");
  assert.equal(state.frame(14.1), "hold");
  state.surface("loading");
  assert.equal(state.frame(14.2), "hold");
  state.surface("ready");
  assert.equal(state.frame(14.2), "play");
  assert.equal(state.frame(15.2), "transition");
});

test("欢迎期间剧情位置保持完整背景，媒体时钟继续；前台续播和退场不跳帧", () => {
  const clock = new StartupSceneClock();
  clock.seek(7.9, 1000);
  clock.setAmbient(true, 1000, 7.9);
  clock.advance(2100, 9);
  assert.equal(clock.elapsed, 7.9);
  assert.equal(clock.resource, 9);
  clock.resume(10100);
  clock.advance(11100, 9);
  assert.equal(clock.elapsed, 7.9);
  assert.equal(clock.resource, 10);
  clock.setAmbient(false, 11100, 7.9);
  clock.advance(11600, 9);
  assert.equal(clock.elapsed, 8.4);
  assert.equal(clock.resource, 10.5);
  clock.seek(2, 12000);
  assert.equal(clock.resource, 2);
});

test("白璃在等待点前正常播放，在就绪后继续至交接点", () => {
  const state = new StartupAnimationState("cinematic", "baili");
  assert.equal(state.frame(11.4), "play");
  assert.equal(state.frame(14.1), "hold");
  state.surface("ready");
  assert.equal(state.frame(14.1), "play");
  assert.equal(state.frame(15.2), "transition");
});

test("爱弥斯在彩色背景完成后等待，真实就绪才进入中央收拢", () => {
  const state = new StartupAnimationState("cinematic", "aemeath");
  assert.equal(state.frame(7.8), "play");
  assert.equal(state.frame(7.95), "hold");
  state.surface("loading");
  assert.equal(state.frame(8.1), "hold");
  state.surface("ready");
  assert.equal(state.frame(7.95), "play");
  assert.equal(state.frame(8.1), "transition");
  state.finish("skip");
  state.surface("ready");
  assert.equal(state.frame(8.95), "finished");
});

test("跳过、错误和媒体结束只撤装饰；晚到回调不能复活", () => {
  for (const ending of ["skip", "media-error", "ended", "watchdog"] as const) {
    const state = new StartupAnimationState("cinematic");
    state.finish(ending);
    state.surface("ready");
    assert.equal(state.frame(11.4), "finished");
    assert.equal(state.reason, ending);
  }
  const state = new StartupAnimationState("cinematic");
  state.surface("attention");
  assert.equal(state.frame(0), "finished");
  assert.equal(state.reason, "attention");
});

test("三种完整动画的欢迎等待不放行业务，确认后的 loading 仍然等待", () => {
  for (const preset of ["baili", "aemeath", "custom"] as const) {
    const state = new StartupAnimationState("cinematic", preset);
    state.surface("welcome");
    assert.equal(state.frame(state.timeline.holdAt), "ambient");
    assert.equal(state.frame(0.2), "ambient");
    state.surface("loading");
    assert.equal(state.frame(state.timeline.transitionStart), "ambient");
    state.surface("ready");
    assert.equal(state.frame(state.timeline.transitionStart), "transition");
  }
});
