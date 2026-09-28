import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema } from "./validationAppSettings.js";
import { lcodeSessionRuntimePreferencesResultSchema } from "./lcode-protocol/index.js";

test("automatic session history recall defaults off in app settings", () => {
  assert.equal(appSettingsSchema.parse({}).sessionRecallEnabled, false);
  assert.deepEqual(appSettingsPatchSchema.parse({ sessionRecallEnabled: true }), {
    sessionRecallEnabled: true,
  });
});

test("runtime preference protocol accepts the app choice and old hosts default off", () => {
  const basePreferences = {
    askUserQuestionAutoResolutionEnabled: true,
    memoryEnabled: false,
    nativeSearchEnhancementsEnabled: true,
  };

  assert.equal(
    lcodeSessionRuntimePreferencesResultSchema.parse(basePreferences).sessionRecallEnabled,
    false,
  );
  assert.equal(
    lcodeSessionRuntimePreferencesResultSchema.parse({
      ...basePreferences,
      sessionRecallEnabled: true,
    }).sessionRecallEnabled,
    true,
  );
});
