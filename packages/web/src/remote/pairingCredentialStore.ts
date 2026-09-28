/**
 * 设备凭据的本地会话存储(cfworker-remote/PROTOCOL.md §4.1):
 * 凭据明文由 Worker 在 pairing.accepted 中唯一一次下发,"手机保存在本地会话存储"。
 * 选 sessionStorage:浏览器会话结束即失效,重开浏览器需重新扫码配对,
 * 与 Worker 侧 TTL/吊销的 fail-closed 语义一致;localStorage 会把长期有效凭据
 * 留在共享/借用设备上,不在 v1 语义内。
 */
const STORAGE_KEY = "lcode:remote-pairing:device";

export interface StoredPairingCredential {
  roomId: string;
  deviceId: string;
  deviceCredential: string;
  grantedAt: number;
}

export function loadStoredPairingCredential(): StoredPairingCredential | null {
  try {
    // 旧键兼容读：老会话凭据存于 zcode:remote-pairing:device。
    const raw =
      window.sessionStorage.getItem(STORAGE_KEY) ||
      window.sessionStorage.getItem("zcode:remote-pairing:device");
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.roomId !== "string" ||
      typeof candidate.deviceId !== "string" ||
      typeof candidate.deviceCredential !== "string" ||
      typeof candidate.grantedAt !== "number"
    ) {
      return null;
    }
    return {
      roomId: candidate.roomId,
      deviceId: candidate.deviceId,
      deviceCredential: candidate.deviceCredential,
      grantedAt: candidate.grantedAt,
    };
  } catch {
    // JSON 损坏或存储不可用(如 Safari 隐私模式):按无凭据处理,走完整配对流程
    return null;
  }
}

export function saveStoredPairingCredential(credential: StoredPairingCredential): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(credential));
  } catch {
    // 存储不可用时跳过:本次会话仍可镜像,页面刷新后需要重新配对
  }
}

/** 清除凭据;传 roomId 时只清除仍指向同一房间的记录,避免误删新配对结果。 */
export function clearStoredPairingCredential(roomId?: string): void {
  try {
    if (roomId === undefined) {
      window.sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    if (loadStoredPairingCredential()?.roomId === roomId) {
      window.sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // 存储不可用时无需清理
  }
}
