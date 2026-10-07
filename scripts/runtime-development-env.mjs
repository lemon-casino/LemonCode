/**
 * 本项目开发入口合同（spec §11/12 的接线补充）：
 * - 端口只读进程 env，不读仅 Vite 可见的 .env，否则代理与 backend/launcher 会分叉。
 * - 空值沿用 5173/3030/5174；非空值必须是十进制整数 1..65535，非法值立即失败。
 * - server 的 LCODE_SERVER_PORT 优先于兼容 PORT；非法主键不能回退到别名。
 * - 环境 owner 为开发 LCode 下发 ID + 私有数据根；入口不分配目录、不修改控制 Host env。
 * - 未托管 test dev 保留历史 $HOME/.lcode-dev-home 隔离默认；显式根始终优先。
 * - LCODE_ENV 仍是产品环境，与运行环境身份、数据隔离无关。
 */
function isAbsent(value) {
  return value === undefined || (typeof value === "string" && value.trim() === "");
}

export function resolveDevelopmentPort(name, value, fallback) {
  const text = isAbsent(value) ? String(fallback) : value;
  const port = typeof text === "string" && /^\d+$/u.test(text.trim()) ? Number(text) : NaN;
  // Number("0"/"1e3"/"0x100") 或 NaN 会触发框架回退/动态端口；统一拒绝，避免串环境。
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError(`${name} must be a decimal integer from 1 to 65535`);
  }
  return port;
}

export function resolveWebPort(env = process.env) {
  return resolveDevelopmentPort("LCODE_WEB_PORT", env.LCODE_WEB_PORT, 5173);
}

export function resolveServerPort(env = process.env) {
  return isAbsent(env.LCODE_SERVER_PORT)
    ? resolveDevelopmentPort("PORT", env.PORT, 3030)
    : resolveDevelopmentPort("LCODE_SERVER_PORT", env.LCODE_SERVER_PORT, 3030);
}

export function resolveDesktopPort(env = process.env) {
  return resolveDevelopmentPort("LCODE_DESKTOP_PORT", env.LCODE_DESKTOP_PORT, 5174);
}

export function resolveServerHost(env = process.env) {
  // 开发 server 原先传 undefined 会实际监听所有网卡；明确 localhost，不自动开放公网。
  return env.LCODE_SERVER_HOST?.trim() || env.HOST?.trim() || "localhost";
}

export function resolveServerProxyHost(env = process.env) {
  const host = resolveServerHost(env);
  // 显式 wildcard 是 bind 地址而不是连接地址；IPv6 URL 需方括号，监听仍使用原始地址。
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "[::1]";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function assertRuntimeDevelopmentDataRoot(env = process.env) {
  // 缺少私有数据根时不能静默继承默认 HOME；目录分配/与控制 Host 隔离由环境 owner 保证。
  if (env.LCODE_RUNTIME_ENVIRONMENT_ID?.trim() && !env.LCODE_DATA_BASE_DIR?.trim()) {
    throw new Error("LCODE_RUNTIME_ENVIRONMENT_ID requires an explicit LCODE_DATA_BASE_DIR");
  }
}

export function withDefaultDevelopmentDataRoot(env, defaultRoot) {
  assertRuntimeDevelopmentDataRoot(env);
  if (env.LCODE_RUNTIME_ENVIRONMENT_ID?.trim() || env.LCODE_DATA_BASE_DIR?.trim()) {
    return env;
  }
  if (!defaultRoot?.trim()) {
    throw new Error("default development data root must be non-empty");
  }
  return { ...env, LCODE_DATA_BASE_DIR: defaultRoot };
}
