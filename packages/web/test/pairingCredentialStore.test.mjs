import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import {
  clearStoredPairingCredential,
  loadStoredPairingCredential,
  saveStoredPairingCredential,
} from "../src/remote/pairingCredentialStore.ts";

// 覆盖点(specs/mobile-remote-reconnect.md):设备凭据的持久存取与会话迁移、
// 形状校验与损坏数据容错;存储不可用(Safari 隐私模式等)时不抛错。
const CREDENTIAL = {
  roomId: "aB3_-xY9kLm2NpQ4rStU6v",
  deviceId: "01890a5d-ac96-774b-bcce-b302099a8057",
  deviceCredential: "zYx-Wvu0TsRqPoNmLkJiHgFeDcBa_9876543210zyxwvutsrqponmlkjihgfedcba",
  grantedAt: 1758950400000,
};

/** 按 Storage 接口模拟 sessionStorage;可注入故障模拟存储不可用。 */
function installSessionStorage({
  broken = false,
  persistentBroken = false,
  persistentWriteBroken = false,
  persistent = new Map(),
} = {}) {
  const backing = new Map();
  const storage = (values, unavailable, writeBroken = false) => {
    const guard =
      (fn) =>
      (...args) => {
        if (unavailable) throw new Error("storage unavailable");
        return fn(...args);
      };
    return {
      getItem: guard((key) => values.get(key) ?? null),
      setItem: guard((key, value) => {
        if (writeBroken) throw new Error("storage quota exceeded");
        values.set(key, String(value));
      }),
      removeItem: guard((key) => values.delete(key)),
    };
  };
  globalThis.window = {
    localStorage: storage(persistent, broken || persistentBroken, persistentWriteBroken),
    sessionStorage: storage(backing, broken),
  };
  return backing;
}

describe("pairingCredentialStore", () => {
  afterEach(() => {
    delete globalThis.window;
  });

  it("save 后 load 还原全部字段", () => {
    const persistent = new Map();
    const backing = installSessionStorage({ persistent });
    saveStoredPairingCredential(CREDENTIAL);
    assert.deepEqual(loadStoredPairingCredential(), CREDENTIAL);
    assert.equal(persistent.size, 1);
    assert.equal(backing.size, 0);
  });

  it("关闭标签页清空 sessionStorage 后，新标签页仍能读取原授权", () => {
    const persistent = new Map();
    installSessionStorage({ persistent });
    saveStoredPairingCredential(CREDENTIAL);
    installSessionStorage({ persistent });
    assert.deepEqual(loadStoredPairingCredential(), CREDENTIAL);
  });

  it("迁移旧 lcode/zcode 会话凭据，迁移后旧键不再是第二写入路径", () => {
    for (const key of ["lcode:remote-pairing:device", "zcode:remote-pairing:device"]) {
      const persistent = new Map();
      const backing = installSessionStorage({ persistent });
      backing.set(key, JSON.stringify(CREDENTIAL));
      assert.deepEqual(loadStoredPairingCredential(), CREDENTIAL);
      assert.equal(backing.size, 0);
      installSessionStorage({ persistent });
      assert.deepEqual(loadStoredPairingCredential(), CREDENTIAL);
    }
  });

  it("持久存储不可用时保持当前标签页会话能力", () => {
    const backing = installSessionStorage({ persistentBroken: true });
    saveStoredPairingCredential(CREDENTIAL);
    assert.deepEqual(loadStoredPairingCredential(), CREDENTIAL);
    assert.equal(backing.size, 1);
  });

  it("持久存储仅写入失败时，旧记录不能遮蔽本次新授权", () => {
    const persistent = new Map([["lcode:remote-pairing:device:v1", JSON.stringify(CREDENTIAL)]]);
    installSessionStorage({ persistent, persistentWriteBroken: true });
    const newer = { ...CREDENTIAL, deviceId: "new-device", deviceCredential: "new-credential" };
    saveStoredPairingCredential(newer);
    assert.deepEqual(loadStoredPairingCredential(), newer);
  });

  it("会话降级的旧连接失败不能擦除另一标签页的新持久授权", () => {
    const persistent = new Map();
    installSessionStorage({ persistent, persistentWriteBroken: true });
    saveStoredPairingCredential(CREDENTIAL);
    const newer = { ...CREDENTIAL, deviceId: "new-device", deviceCredential: "new-credential" };
    persistent.set("lcode:remote-pairing:device:v1", JSON.stringify(newer));
    clearStoredPairingCredential(undefined, CREDENTIAL.deviceCredential);
    assert.deepEqual(loadStoredPairingCredential(), newer);
    assert.equal(globalThis.window.sessionStorage.getItem("lcode:remote-pairing:device:v1"), null);
  });

  it("清理撤销凭据时同时移除旧键，不能从旧记录复活", () => {
    const persistent = new Map();
    const backing = installSessionStorage({ persistent });
    backing.set("zcode:remote-pairing:device", JSON.stringify(CREDENTIAL));
    assert.deepEqual(loadStoredPairingCredential(), CREDENTIAL);
    clearStoredPairingCredential(CREDENTIAL.roomId, CREDENTIAL.deviceCredential);
    assert.equal(loadStoredPairingCredential(), null);
    assert.equal(persistent.size, 0);
    assert.equal(backing.size, 0);
  });

  it("旧连接的迟到失败不能清除相同房间中新授权的设备", () => {
    installSessionStorage();
    const newer = {
      ...CREDENTIAL,
      deviceId: "new-device",
      deviceCredential: "new-device-credential",
    };
    saveStoredPairingCredential(newer);
    clearStoredPairingCredential(CREDENTIAL.roomId, CREDENTIAL.deviceCredential);
    assert.deepEqual(loadStoredPairingCredential(), newer);
  });

  it("损坏的持久凭据不能回退复活旧会话凭据", () => {
    const persistent = new Map([["lcode:remote-pairing:device:v1", "{invalid"]]);
    const backing = installSessionStorage({ persistent });
    backing.set("zcode:remote-pairing:device", JSON.stringify(CREDENTIAL));
    assert.equal(loadStoredPairingCredential(), null);
  });

  it("无记录/形状不完整/JSON 损坏一律返回 null", () => {
    installSessionStorage();
    assert.equal(loadStoredPairingCredential(), null);

    installSessionStorage();
    globalThis.window.sessionStorage.setItem(
      "zcode:remote-pairing:device",
      JSON.stringify({ roomId: "r" }),
    );
    assert.equal(loadStoredPairingCredential(), null);

    installSessionStorage();
    globalThis.window.sessionStorage.setItem("zcode:remote-pairing:device", "{not json");
    assert.equal(loadStoredPairingCredential(), null);
  });

  it("clear() 整体清除;clear(roomId) 只清匹配房间的记录", () => {
    installSessionStorage();
    saveStoredPairingCredential(CREDENTIAL);
    clearStoredPairingCredential("another-room");
    assert.notEqual(loadStoredPairingCredential(), null);
    clearStoredPairingCredential(CREDENTIAL.roomId);
    assert.equal(loadStoredPairingCredential(), null);

    installSessionStorage();
    saveStoredPairingCredential(CREDENTIAL);
    clearStoredPairingCredential();
    assert.equal(loadStoredPairingCredential(), null);
  });

  it("存储不可用时 save/clear/load 均不抛错", () => {
    installSessionStorage({ broken: true });
    assert.doesNotThrow(() => saveStoredPairingCredential(CREDENTIAL));
    assert.doesNotThrow(() => clearStoredPairingCredential());
    assert.equal(loadStoredPairingCredential(), null);
  });
});
