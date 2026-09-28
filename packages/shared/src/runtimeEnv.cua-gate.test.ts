import assert from "node:assert/strict";
import test from "node:test";

import {
  sanitizeLCodeRuntimeEnv,
  isLCodeCuaInternalFeatureEnabled,
  LCODE_CUA_DEV_MODE_ENV_KEY,
  LCODE_CUA_PRODUCT_HELPER_ENV_KEY,
} from "./runtimeEnv.js";

const LEGACY_BROKER_CAPABILITY_ENV = "LCODE_CUA_PERMISSION_BROKER_CAPABILITY";

test("CUA internal feature is fail-closed unless an internal switch is explicitly true", () => {
  const disabledCases = [
    {},
    { [LCODE_CUA_PRODUCT_HELPER_ENV_KEY]: "" },
    { [LCODE_CUA_PRODUCT_HELPER_ENV_KEY]: "0" },
    { [LCODE_CUA_PRODUCT_HELPER_ENV_KEY]: "false" },
    { [LCODE_CUA_PRODUCT_HELPER_ENV_KEY]: "off" },
    { [LCODE_CUA_PRODUCT_HELPER_ENV_KEY]: "unexpected" },
    { [LCODE_CUA_DEV_MODE_ENV_KEY]: "false" },
    { [LCODE_CUA_DEV_MODE_ENV_KEY]: "unexpected" },
  ];

  for (const env of disabledCases) {
    assert.equal(isLCodeCuaInternalFeatureEnabled(env), false, JSON.stringify(env));
  }
});

test("CUA internal feature accepts only explicit true values", () => {
  for (const value of ["1", "true", "on", " TRUE ", " On "]) {
    assert.equal(
      isLCodeCuaInternalFeatureEnabled({ [LCODE_CUA_PRODUCT_HELPER_ENV_KEY]: value }),
      true,
      value,
    );
  }

  assert.equal(
    isLCodeCuaInternalFeatureEnabled({
      [LCODE_CUA_DEV_MODE_ENV_KEY]: "on",
      [LCODE_CUA_PRODUCT_HELPER_ENV_KEY]: "off",
    }),
    true,
  );
});

test("legacy CUA broker capability is removed from the generic runtime environment", () => {
  assert.deepEqual(
    sanitizeLCodeRuntimeEnv({
      [LEGACY_BROKER_CAPABILITY_ENV]: "stale-capability",
      LCODE_TEST_KEEP: "kept",
    }),
    { LCODE_TEST_KEEP: "kept" },
  );
});
