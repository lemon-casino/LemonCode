export function isCuaPermissionStatusAvailable(result) {
  // services 的成功态沿用无 `available` 字段的旧 wire 形状；只有显式 false 才是不支持。
  return (
    Boolean(result) &&
    typeof result === "object" &&
    result.available !== false &&
    ["granted", "stale", "denied", "unknown"].includes(result.accessibility) &&
    ["granted", "denied", "unknown"].includes(result.screenRecording)
  );
}

export function shouldRunCuaScreenCaptureProbe(state, options) {
  if (state !== "granted") return false;
  // 后台刷新必须保持只读；只有用户授权返回后的显式功能探针才允许真实抓屏。
  return options?.probeScreenCapture === true || options?.includeFunctionalProbes === true;
}
