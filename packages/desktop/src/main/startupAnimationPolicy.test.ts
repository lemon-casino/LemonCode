import assert from "node:assert/strict";
import { test } from "node:test";
import { createStartupAnimationPolicy } from "./startupAnimationPolicy.js";

test("只有进程首个主窗口消费动画资格，设置快照不变成第二个设置 owner", () => {
  const policy = createStartupAnimationPolicy(() => "process-launch");
  assert.deepEqual(policy.take({ mode: "cinematic", volume: 0, preset: "baili" }), {
    enabled: true,
    launchId: "process-launch",
    settings: { mode: "cinematic", volume: 0, preset: "baili" },
  });
  assert.equal(policy.take(undefined).enabled, false);
  assert.equal(policy.take({ mode: "off", volume: 0, preset: "baili" }).enabled, false);
});
