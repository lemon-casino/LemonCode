import assert from "node:assert/strict";
import test from "node:test";

import { isCuaPermissionStatusAvailable, shouldRunCuaScreenCaptureProbe } from "./broker-ports.js";

test("permission status accepts the services success shape and rejects unavailable/malformed data", () => {
  assert.equal(
    isCuaPermissionStatusAvailable({
      grantOwner: "dev.zcode.cua-helper",
      accessibility: "granted",
      screenRecording: "denied",
    }),
    true,
  );
  assert.equal(
    isCuaPermissionStatusAvailable({
      available: false,
      reason: "not running",
    }),
    false,
  );
  assert.equal(
    isCuaPermissionStatusAvailable({ accessibility: "granted", screenRecording: "invalid" }),
    false,
  );
});

test("screen capture runs only after a grant and an explicit functional-probe request", () => {
  assert.equal(shouldRunCuaScreenCaptureProbe("granted"), false);
  assert.equal(shouldRunCuaScreenCaptureProbe("granted", { includeFunctionalProbes: true }), true);
  assert.equal(shouldRunCuaScreenCaptureProbe("granted", { probeScreenCapture: true }), true);
  assert.equal(shouldRunCuaScreenCaptureProbe("denied", { includeFunctionalProbes: true }), false);
});
