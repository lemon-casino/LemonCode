const LCODE_JWT_INVALID_RESTART_MARKER_KEY = "lcode:auth:jwt-invalid-restart";

interface RestartMarkerStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

function resolveStorage(storage?: RestartMarkerStorage): RestartMarkerStorage | null {
  if (storage) {
    return storage;
  }
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function markLcodeJwtInvalidRestart(storage?: RestartMarkerStorage): void {
  resolveStorage(storage)?.setItem(LCODE_JWT_INVALID_RESTART_MARKER_KEY, "1");
}

export function consumeLcodeJwtInvalidRestartMarker(storage?: RestartMarkerStorage): boolean {
  const resolved = resolveStorage(storage);
  if (!resolved || resolved.getItem(LCODE_JWT_INVALID_RESTART_MARKER_KEY) !== "1") {
    return false;
  }
  // 该标记只服务于本次重启；如果不在读取时删除，后续正常启动仍会被强制带回登录页。
  resolved.removeItem(LCODE_JWT_INVALID_RESTART_MARKER_KEY);
  return true;
}
