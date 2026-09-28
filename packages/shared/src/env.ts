import type { LCodeRuntimeEnv } from "./runtimeEnv.js";

export type LCodeEnv = "test" | "production";
/** 安装包身份：决定应用名、app id、Electron 数据目录与更新策略；与后端环境 `LCodeEnv` 是两个轴。 */
export type LCodeProductFlavor = "production" | "preview";
export type ArmsRumEnv = "local" | "prod";

// 非构建环境（如 e2e 测试的 mocha）下 define 不存在，用 typeof 检查 + fallback 避免 ReferenceError
declare const __LCODE_ENV__: string;
declare const __LCODE_PRODUCT_FLAVOR__: string;

export function normalizeLCodeEnv(value: string | undefined): LCodeEnv {
  return value?.trim().toLowerCase() === "production" ? "production" : "test";
}

export const LCODE_ENV = normalizeLCodeEnv(
  typeof __LCODE_ENV__ !== "undefined" ? __LCODE_ENV__ : undefined,
);

/**
 * 身份缺省跟随后端环境（test → preview，production → production）。
 * 桌面构建通过 `LCODE_PREVIEW_IDENTITY=1` 显式注入 preview，得到连接生产后端的 Preview 包；
 * 未注入 define 的 bundle（web、CLI、测试）沿用旧的单轴语义。
 */
export function normalizeLCodeProductFlavor(
  value: string | undefined,
  lcodeEnv: LCodeEnv,
): LCodeProductFlavor {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "production" || normalized === "preview") {
    return normalized;
  }
  return lcodeEnv === "production" ? "production" : "preview";
}

export const LCODE_PRODUCT_FLAVOR = normalizeLCodeProductFlavor(
  typeof __LCODE_PRODUCT_FLAVOR__ !== "undefined" ? __LCODE_PRODUCT_FLAVOR__ : undefined,
  LCODE_ENV,
);
export const LCODE_APP_VERSION_ENV = "LCODE_APP_VERSION" as const;
export const LCODE_BUILD_COMMIT_ID_ENV = "LCODE_BUILD_COMMIT_ID" as const;

// ── 运行时环境变量（不经过编译打包，启动时从 process.env 读取） ──
// 启用调试模式，值为 inspect-brk 的端口号，如 LCODE_DEBUG=9230
export const RUNTIME_LCODE_DEBUG =
  typeof process !== "undefined" ? process.env.LCODE_DEBUG : undefined;

// 恢复原因：写死 false 会让运行时已配置的数仓/ARMS 永远空转。
// 功能保持可用；实际出网由各出口的运行时端点检查决定，未配置不上报。
export const LCODE_TELEMETRY_ENABLED: boolean = true;

/** 数仓事件上报端点：由运行时环境变量提供，未配置即停用，构建产物不内嵌。 */
export const LCODE_TELEMETRY_REPORT_ENDPOINT =
  typeof process !== "undefined" ? (process.env.LCODE_TELEMETRY_REPORT_ENDPOINT ?? "") : "";

/** ARMS RUM 接入端点：由运行时环境变量提供，未配置即停用，构建产物不内嵌。 */
export const LCODE_ARMS_RUM_ENDPOINT =
  typeof process !== "undefined" ? (process.env.LCODE_ARMS_RUM_ENDPOINT ?? "") : "";

/** 将本地运行态与编译期 LCODE_ENV 映射为 ARMS 控制台识别的上报环境标签 */
export function mapLCodeEnvToArmsRumEnv(runtimeEnv: LCodeRuntimeEnv): ArmsRumEnv {
  return runtimeEnv !== "development" && LCODE_ENV === "production" ? "prod" : "local";
}
