import assert from "node:assert/strict";
import test from "node:test";

import {
  sanitizeZCodeRuntimeEnv,
  isZCodeCuaInternalFeatureEnabled,
  ZCODE_CUA_DEV_MODE_ENV_KEY,
  ZCODE_CUA_PRODUCT_HELPER_ENV_KEY,
} from "./runtimeEnv.js";

const LEGACY_BROKER_CAPABILITY_ENV = "ZCODE_CUA_PERMISSION_BROKER_CAPABILITY";

test("CUA internal feature is fail-closed unless an internal switch is explicitly true", () => {
  const disabledCases = [
    {},
    { [ZCODE_CUA_PRODUCT_HELPER_ENV_KEY]: "" },
    { [ZCODE_CUA_PRODUCT_HELPER_ENV_KEY]: "0" },
    { [ZCODE_CUA_PRODUCT_HELPER_ENV_KEY]: "false" },
    { [ZCODE_CUA_PRODUCT_HELPER_ENV_KEY]: "off" },
    { [ZCODE_CUA_PRODUCT_HELPER_ENV_KEY]: "unexpected" },
    { [ZCODE_CUA_DEV_MODE_ENV_KEY]: "false" },
    { [ZCODE_CUA_DEV_MODE_ENV_KEY]: "unexpected" },
  ];

  for (const env of disabledCases) {
    assert.equal(isZCodeCuaInternalFeatureEnabled(env), false, JSON.stringify(env));
  }
});

test("CUA internal feature accepts only explicit true values", () => {
  for (const value of ["1", "true", "on", " TRUE ", " On "]) {
    assert.equal(
      isZCodeCuaInternalFeatureEnabled({ [ZCODE_CUA_PRODUCT_HELPER_ENV_KEY]: value }),
      true,
      value,
    );
  }

  assert.equal(
    isZCodeCuaInternalFeatureEnabled({
      [ZCODE_CUA_DEV_MODE_ENV_KEY]: "on",
      [ZCODE_CUA_PRODUCT_HELPER_ENV_KEY]: "off",
    }),
    true,
  );
});

test("legacy CUA broker capability is removed from the generic runtime environment", () => {
  assert.deepEqual(
    sanitizeZCodeRuntimeEnv({
      [LEGACY_BROKER_CAPABILITY_ENV]: "stale-capability",
      ZCODE_TEST_KEEP: "kept",
    }),
    { ZCODE_TEST_KEEP: "kept" },
  );
});
