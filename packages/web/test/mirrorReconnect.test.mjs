import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  CREDENTIAL_DEATH_KEYS,
  DATA_SOCKET_RETRY_DEADLINE_MS,
  DATA_SOCKET_RETRY_KEYS,
  MIRROR_RECONNECT_KEYS,
  MIRROR_RELOAD_BUDGET,
  MIRROR_RELOAD_WINDOW_MS,
  planMirrorReconnectReload,
  shouldFallbackToPairingCapability,
} from "../src/remote/mirrorReconnect.ts";

// 覆盖点(契约 §3.3 / specs/mobile-remote-control-cf-workers.md:87):
// 接管后仅网络类断链自动刷新重连;建连阶段仅对 busy/网络类失败有界重试;
// 自动刷新受防循环预算约束。
describe("mirrorReconnect policy", () => {
  it("房间死亡或停止不删除跨房间仍有效的设备授权", () => {
    for (const key of ["network", "busy", "stopped", "expired", "room-missing", "invalidated"]) {
      assert.equal(CREDENTIAL_DEATH_KEYS.has(key), false);
    }
    assert.equal(CREDENTIAL_DEATH_KEYS.has("auth"), true);
    assert.equal(CREDENTIAL_DEATH_KEYS.has("revoked"), true);
  });

  it("重连网络/房间失败及原房间鉴权失败不能重放 capability", () => {
    for (const key of [
      "network",
      "busy",
      "heartbeat",
      "bridge-timeout",
      "stopped",
      "expired",
      "invalidated",
      "revoked",
    ]) {
      assert.equal(
        shouldFallbackToPairingCapability({
          key,
          storedRoomId: "old-room",
          routeRoomId: "new-room",
          hasCapability: true,
        }),
        false,
      );
    }
    assert.equal(
      shouldFallbackToPairingCapability({
        key: "auth",
        storedRoomId: "same-room",
        routeRoomId: "same-room",
        hasCapability: true,
      }),
      false,
    );
  });

  it("新房间设备鉴权失败仅在具有新 capability 时重新确认", () => {
    assert.equal(
      shouldFallbackToPairingCapability({
        key: "auth",
        storedRoomId: "old-room",
        routeRoomId: "new-room",
        hasCapability: true,
      }),
      true,
    );
    assert.equal(
      shouldFallbackToPairingCapability({
        key: "auth",
        storedRoomId: "old-room",
        routeRoomId: "new-room",
        hasCapability: false,
      }),
      false,
    );
  });
  it("接管后仅网络类断链触发自动刷新,凭据/房间类死亡不重连", () => {
    assert.equal(MIRROR_RECONNECT_KEYS.has("network"), true);
    assert.equal(MIRROR_RECONNECT_KEYS.has("heartbeat"), true);
    assert.equal(MIRROR_RECONNECT_KEYS.has("busy"), true);
    // 桌面停止/吊销(4007)、凭据失效(4002)、房间关闭(4004/4005/4006)不重连:
    // 重连必然失败且白耗 §3.1 失败计数
    assert.equal(MIRROR_RECONNECT_KEYS.has("stopped"), false);
    assert.equal(MIRROR_RECONNECT_KEYS.has("auth"), false);
    assert.equal(MIRROR_RECONNECT_KEYS.has("room-missing"), false);
    assert.equal(MIRROR_RECONNECT_KEYS.has("expired"), false);
    assert.equal(MIRROR_RECONNECT_KEYS.has("invalidated"), false);
  });

  it("建连重试仅覆盖 busy/网络类失败,截止时间覆盖旧桥约 75s 心跳回收", () => {
    assert.equal(DATA_SOCKET_RETRY_KEYS.has("busy"), true);
    assert.equal(DATA_SOCKET_RETRY_KEYS.has("network"), true);
    assert.equal(DATA_SOCKET_RETRY_KEYS.has("heartbeat"), true);
    assert.equal(DATA_SOCKET_RETRY_KEYS.has("auth"), false);
    assert.equal(DATA_SOCKET_RETRY_KEYS.has("stopped"), false);
    assert.ok(DATA_SOCKET_RETRY_DEADLINE_MS >= 75_000);
  });

  it("planMirrorReconnectReload:预算内允许刷新并累计时间戳", () => {
    const plan = planMirrorReconnectReload([], 1_000_000);
    assert.equal(plan.reload, true);
    assert.deepEqual(plan.next, [1_000_000]);
  });

  it("planMirrorReconnectReload:窗口外旧时间戳不占预算", () => {
    const now = MIRROR_RELOAD_WINDOW_MS * 10;
    const stale = Array.from({ length: MIRROR_RELOAD_BUDGET }, (_, index) => index);
    const plan = planMirrorReconnectReload(stale, now);
    assert.equal(plan.reload, true);
    assert.deepEqual(plan.next, [now]);
  });

  it("planMirrorReconnectReload:窗口内达预算上限则拒绝刷新并保留记录", () => {
    const now = 10_000_000;
    const recent = Array.from({ length: MIRROR_RELOAD_BUDGET }, (_, index) => now - index * 1000);
    const plan = planMirrorReconnectReload(recent, now);
    assert.equal(plan.reload, false);
    assert.deepEqual(plan.next, recent);
  });

  it("planMirrorReconnectReload:非法输入按空历史处理", () => {
    const plan = planMirrorReconnectReload("garbage", 5_000_000);
    assert.equal(plan.reload, true);
    assert.deepEqual(plan.next, [5_000_000]);
  });
});
