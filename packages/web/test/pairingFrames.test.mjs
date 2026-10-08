import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { describePairingClose, parsePairingControlFrame } from "../src/remote/pairingFrames.ts";

// 覆盖点(cfworker-remote/PROTOCOL.md §2/§3.2):TEXT 控制帧解析的容错性
// (二进制/非 JSON/缺 type 一律 null 不抛错)与语义化关闭码到失败文案 key 的映射。
describe("parsePairingControlFrame", () => {
  it("解析 TEXT JSON 控制帧并保留字段", () => {
    const raw = JSON.stringify({
      type: "pairing.accepted",
      requestId: "r1",
      deviceId: "d1",
      deviceCredential: "cred",
    });
    assert.deepEqual(parsePairingControlFrame(raw), {
      type: "pairing.accepted",
      requestId: "r1",
      deviceId: "d1",
      deviceCredential: "cred",
    });
  });

  it("二进制(非 string)、空串、非 JSON、缺 type 一律返回 null", () => {
    assert.equal(parsePairingControlFrame(new Uint8Array([1, 2, 3])), null);
    assert.equal(parsePairingControlFrame(undefined), null);
    assert.equal(parsePairingControlFrame(""), null);
    assert.equal(parsePairingControlFrame("not json {"), null);
    assert.equal(parsePairingControlFrame(JSON.stringify({ foo: 1 })), null);
    assert.equal(parsePairingControlFrame(JSON.stringify([1, 2])), null);
  });
});

describe("describePairingClose", () => {
  it("房间停止与设备撤销具有不同的凭据生命周期", () => {
    assert.equal(describePairingClose(4007, "room stopped"), "stopped");
    assert.equal(describePairingClose(4007, "device revoked"), "revoked");
    assert.equal(describePairingClose(4007), "stopped");
  });
  it("Worker 语义化关闭码逐一映射(§3.2)", () => {
    assert.equal(describePairingClose(4001), "heartbeat");
    assert.equal(describePairingClose(4002), "auth");
    assert.equal(describePairingClose(4003), "protocol");
    assert.equal(describePairingClose(4004), "room-missing");
    assert.equal(describePairingClose(4005), "expired");
    assert.equal(describePairingClose(4006), "invalidated");
    assert.equal(describePairingClose(4007), "stopped");
    assert.equal(describePairingClose(4008), "busy");
  });

  it("未知/网络层关闭码统一按 network,不区分具体原因(§4.3 防枚举)", () => {
    assert.equal(describePairingClose(1000), "network");
    assert.equal(describePairingClose(1006), "network");
    assert.equal(describePairingClose(4500), "network");
  });
});
