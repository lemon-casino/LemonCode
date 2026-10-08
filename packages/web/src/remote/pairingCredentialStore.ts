/** 设备凭据唯一存储入口；规则见 specs/mobile-remote-reconnect.md。 */
const STORAGE_KEY = "lcode:remote-pairing:device:v1";
const LEGACY_KEYS = ["lcode:remote-pairing:device", "zcode:remote-pairing:device"] as const;

export interface StoredPairingCredential {
  roomId: string;
  deviceId: string;
  deviceCredential: string;
  grantedAt: number;
}

function getStorage(kind: "localStorage" | "sessionStorage"): Storage | null {
  try {
    return window[kind] ?? null;
  } catch {
    // 隐私模式可能在读取 Storage 属性时直接抛错；只降级存储能力，不绕过授权。
    return null;
  }
}

function read(storage: Storage | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function remove(storage: Storage | null, keys: readonly string[]): void {
  for (const key of keys) {
    try {
      storage?.removeItem(key);
    } catch {
      // 存储拒绝访问不影响当前连接；其它存储和旧键仍各自清理。
    }
  }
}

function parse(raw: string): StoredPairingCredential | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.roomId !== "string" ||
      !candidate.roomId.trim() ||
      typeof candidate.deviceId !== "string" ||
      !candidate.deviceId.trim() ||
      typeof candidate.deviceCredential !== "string" ||
      !candidate.deviceCredential.trim() ||
      typeof candidate.grantedAt !== "number" ||
      !Number.isFinite(candidate.grantedAt) ||
      candidate.grantedAt < 0
    )
      return null;
    return {
      roomId: candidate.roomId,
      deviceId: candidate.deviceId,
      deviceCredential: candidate.deviceCredential,
      grantedAt: candidate.grantedAt,
    };
  } catch {
    return null;
  }
}

export function loadStoredPairingCredential(): StoredPairingCredential | null {
  const session = getStorage("sessionStorage");
  const fallback = read(session, STORAGE_KEY);
  // 仅写入被拒绝时旧持久记录仍可读；本标签页的版本化降级记录才是当前授权。
  // 不在读取时反向写入持久层，避免旧标签页覆盖另一标签页的新授权。
  if (fallback !== null) return parse(fallback);
  const persisted = read(getStorage("localStorage"), STORAGE_KEY);
  // 已存在的版本化记录即权威来源；损坏时不能复活旧会话里的已撤销凭据。
  if (persisted !== null) return parse(persisted);
  for (const key of LEGACY_KEYS) {
    const raw = read(session, key);
    if (raw === null) continue;
    const credential = parse(raw);
    if (credential) saveStoredPairingCredential(credential);
    return credential;
  }
  return null;
}

export function saveStoredPairingCredential(credential: StoredPairingCredential): void {
  const raw = JSON.stringify({
    roomId: credential.roomId,
    deviceId: credential.deviceId,
    deviceCredential: credential.deviceCredential,
    grantedAt: credential.grantedAt,
  });
  const session = getStorage("sessionStorage");
  try {
    const persistent = getStorage("localStorage");
    if (!persistent) throw new Error("persistent storage unavailable");
    // 原 sessionStorage 会随标签页关闭丢失，重开旧链接就重放 consume-once capability。
    // 记住设备后以同源持久存储为唯一来源，成功写入才移除旧会话副本。
    persistent.setItem(STORAGE_KEY, raw);
    remove(session, [STORAGE_KEY, ...LEGACY_KEYS]);
    return;
  } catch {
    // 持久存储不可用时保留本标签页能力；不承诺关闭页面后仍能恢复。
  }
  try {
    session?.setItem(STORAGE_KEY, raw);
    if (session) remove(session, LEGACY_KEYS);
  } catch {
    // 两种存储都不可用时仍允许当前已获授权的连接，不把凭据写到其它载体。
  }
}

/** 可按房间和具体凭据清理，防止旧连接的迟到鉴权失败擦除新授权。 */
export function clearStoredPairingCredential(roomId?: string, deviceCredential?: string): void {
  // 分别比较各载体的记录：会话降级中的旧失败不能擦除另一标签页的新持久授权。
  for (const kind of ["localStorage", "sessionStorage"] as const) {
    const storage = getStorage(kind);
    for (const key of [STORAGE_KEY, ...LEGACY_KEYS]) {
      if (roomId !== undefined || deviceCredential !== undefined) {
        const raw = read(storage, key);
        const current = raw === null ? null : parse(raw);
        if (roomId !== undefined && current?.roomId !== roomId) continue;
        if (deviceCredential !== undefined && current?.deviceCredential !== deviceCredential)
          continue;
      }
      // 同一撤销凭据的所有旧副本必须退休，不能从旧 zcode 记录复活。
      remove(storage, [key]);
    }
  }
}
