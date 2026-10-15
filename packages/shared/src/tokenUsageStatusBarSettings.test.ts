import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema } from "./validationAppSettings.js";

test("旧设置默认开启状态栏；分项关闭和动画偏好可独立持久化", () => {
  const defaults = appSettingsSchema.parse({}).tokenUsageStatusBar;
  assert.ok(defaults);
  assert.equal(defaults.position, "inside");
  assert.ok(
    Object.entries(defaults)
      .filter(([key]) => key !== "position")
      .every(([, value]) => value === true),
  );
  for (const position of ["inside", "below", "above"] as const) {
    assert.equal(
      appSettingsSchema.parse({ tokenUsageStatusBar: { position } }).tokenUsageStatusBar?.position,
      position,
    );
  }
  assert.equal(
    appSettingsPatchSchema.safeParse({ tokenUsageStatusBar: { position: "floating" } }).success,
    false,
  );
  const value = { ...defaults, speed: false, animations: false };
  assert.deepEqual(
    appSettingsSchema.parse({ tokenUsageStatusBar: value }).tokenUsageStatusBar,
    value,
  );
  assert.deepEqual(
    appSettingsPatchSchema.parse({ tokenUsageStatusBar: value }).tokenUsageStatusBar,
    value,
  );
  assert.equal(
    appSettingsPatchSchema.safeParse({ tokenUsageStatusBar: { speed: "false" } }).success,
    false,
  );
  assert.equal(appSettingsPatchSchema.parse({}).tokenUsageStatusBar, undefined);
});
