import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveStartupSurface } from "./startupSurface.js";

test("Root 可展示投影不能把空 workspace 或未完成恢复当成功", () => {
  const pending = { blocked: true, hasWorkspace: false, attention: false };
  assert.equal(resolveStartupSurface(pending), "loading");
  assert.equal(resolveStartupSurface({ ...pending, blocked: false }), "loading");
  assert.equal(resolveStartupSurface({ ...pending, hasWorkspace: true }), "loading");
  assert.equal(
    resolveStartupSurface({ blocked: false, hasWorkspace: true, attention: false }),
    "ready",
  );
});

test("登录、确认与错误优先于 loading，可见不意味着业务放行", () => {
  assert.equal(
    resolveStartupSurface({ blocked: true, hasWorkspace: false, attention: true }),
    "attention",
  );
});

test("首次欢迎只投影 welcome，不代表项目 ready；错误和确认仍优先", () => {
  const welcome = { blocked: true, hasWorkspace: false, attention: false, welcome: true };
  assert.equal(resolveStartupSurface(welcome), "welcome");
  assert.equal(resolveStartupSurface({ ...welcome, attention: true }), "attention");
  assert.equal(resolveStartupSurface({ ...welcome, welcome: false }), "loading");
});
