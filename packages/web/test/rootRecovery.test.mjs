import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { tsImport } from "tsx/esm/api";
const {
  getRootRecoveryTarget,
  isRootRecoveryEntry,
  finishRootRecovery,
  returnRootRecoveryToWebsite,
} = await tsImport("../src/remote/rootRecovery.ts", import.meta.url);

const key = "lcode:remote-pairing:device:v1";
const grant = {
  roomId: "room_123456",
  deviceId: "demo-device",
  deviceCredential: "demo-secret",
  grantedAt: 1,
};
function browser(path, record = grant) {
  const local = new Map(record ? [[key, JSON.stringify(record)]] : []);
  const session = new Map();
  const storage = (map) => ({
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  });
  const url = new URL(path, "https://site.invalid");
  const redirects = [];
  const history = [];
  globalThis.window = {
    location: {
      href: url.href,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      replace: (target) => redirects.push(target),
    },
    localStorage: storage(local),
    sessionStorage: storage(session),
    history: { state: { preserved: true }, replaceState: (...args) => history.push(args) },
  };
  return { local, session, redirects, history };
}
afterEach(() => {
  delete globalThis.window;
});
test("根入口复用既有凭据，只把合法 roomId 写入恢复地址", () => {
  browser("/");
  assert.equal(getRootRecoveryTarget(window.location), "/p/room_123456?entry=root");
  assert.equal(getRootRecoveryTarget(window.location).includes(grant.deviceCredential), false);
  browser("/", { ...grant, roomId: "../../ws" });
  assert.equal(getRootRecoveryTarget(window.location), null);
});
test("无凭据、损坏权威记录和不可读存储保持官网，不复活旧授权", () => {
  const state = browser("/", null);
  assert.equal(getRootRecoveryTarget(window.location), null);
  state.local.set(key, "broken");
  state.session.set("zcode:remote-pairing:device", JSON.stringify(grant));
  assert.equal(getRootRecoveryTarget(window.location), null);
  Object.defineProperty(window, "localStorage", {
    get() {
      throw new Error("denied");
    },
  });
  Object.defineProperty(window, "sessionStorage", {
    get() {
      throw new Error("denied");
    },
  });
  assert.equal(getRootRecoveryTarget(window.location), null);
});
test("显式官网、下载、说明、分享和回调均不读取配对存储", () => {
  for (const path of ["/?view=site", "/download", "/remote", "/share/123", "/oauth/callback"]) {
    browser(path);
    Object.defineProperty(window, "localStorage", {
      get() {
        assert.fail("must not read");
        return undefined;
      },
    });
    Object.defineProperty(window, "sessionStorage", {
      get() {
        assert.fail("must not read");
        return undefined;
      },
    });
    assert.equal(getRootRecoveryTarget(window.location), null);
  }
});
test("只处理根恢复，成功保留其它导航信息并撤下入口标记", () => {
  const state = browser("/p/room_123456?entry=root&keep=1#task=demo");
  assert.equal(isRootRecoveryEntry(window.location), true);
  finishRootRecovery();
  assert.deepEqual(state.history, [[{ preserved: true }, "", "/p/room_123456?keep=1#task=demo"]]);
  browser("/p/room_123456?entry=root#c=capability_123");
  assert.equal(isRootRecoveryEntry(window.location), false);
  browser("/p/room_123456");
  assert.equal(isRootRecoveryEntry(window.location), false);
});
test("根恢复失败回官网，网络失败保留授权，迟到结果不打断新授权或导航", () => {
  const state = browser("/p/room_123456?entry=root");
  const origin = window.location.href;
  assert.equal(returnRootRecoveryToWebsite("network", origin, grant.deviceCredential), true);
  assert.deepEqual(state.redirects, ["/?view=site&remote=unavailable"]);
  assert.deepEqual(JSON.parse(state.local.get(key)), grant);
  state.local.set(key, JSON.stringify({ ...grant, deviceCredential: "new-secret" }));
  assert.equal(returnRootRecoveryToWebsite("auth", origin, grant.deviceCredential), false);
  state.local.delete(key);
  assert.equal(returnRootRecoveryToWebsite("revoked", origin, grant.deviceCredential), true);
  window.location.href = "https://site.invalid/download";
  assert.equal(returnRootRecoveryToWebsite("auth", origin, grant.deviceCredential), false);
});
