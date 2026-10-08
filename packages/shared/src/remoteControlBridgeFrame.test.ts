import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeRemoteControlBridgeFrame,
  decodeRemoteControlBridgeFrame,
} from "./remoteControlBridgeFrame.js";
test("multi-device routing wire vector and independent payload ownership", () => {
  const payload = Uint8Array.of(0, 255, 3);
  const frame = encodeRemoteControlBridgeFrame("A", payload);
  assert.deepEqual([...frame], [76, 67, 82, 77, 1, 0, 1, 65, 0, 255, 3]);
  const decoded = decodeRemoteControlBridgeFrame(frame);
  assert.equal(decoded.deviceId, "A");
  assert.deepEqual(decoded.payload, payload);
  assert.equal(
    decodeRemoteControlBridgeFrame(encodeRemoteControlBridgeFrame("设备-B", payload)).deviceId,
    "设备-B",
  );
});
test("malformed routes and oversized payloads are rejected", () => {
  const valid = encodeRemoteControlBridgeFrame("A", Uint8Array.of(9));
  for (const offset of [0, 4, 5, 6, 7]) {
    const bad = valid.slice();
    bad[offset] = 255;
    assert.throws(() => decodeRemoteControlBridgeFrame(bad));
  }
  for (let length = 0; length < 8; length++)
    assert.throws(() => decodeRemoteControlBridgeFrame(valid.slice(0, length)));
  for (const id of ["", "x".repeat(257), "A\n", "\u007f"])
    assert.throws(() => encodeRemoteControlBridgeFrame(id, Uint8Array.of(9)));
  assert.throws(() => encodeRemoteControlBridgeFrame("A", new Uint8Array(1_048_577)));
  assert.equal(
    decodeRemoteControlBridgeFrame(encodeRemoteControlBridgeFrame("A", new Uint8Array(1_048_576)))
      .payload.length,
    1_048_576,
  );
});
