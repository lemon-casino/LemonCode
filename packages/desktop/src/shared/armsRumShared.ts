import {
  mapLCodeEnvToArmsRumEnv,
  type LCodeRuntimeEnv,
  LCODE_ARMS_RUM_ENDPOINT,
  LCODE_VERSION,
} from "@lcode/shared";

/** 主进程 init 的 browserCollectors，经 autoInject 注入到 renderer 的 RumSDK.init(collectors) */
export const ARMS_BROWSER_COLLECTORS = {
  perf: true,
  webvitals: true,
  exception: true,
  whiteScreen: true,
  api: true,
  staticResource: true,
  // 开启 click 采集用户行为；桌面端交互密集，上报量与噪音会上升，需关注 ARMS 用量
  click: true,
  longTask: true,
} as const;

/** ARMS 页面名解析：file:// 与 dev-server 统一规则，主进程 parseViewName 与 renderer 共用 */
export function parseArmsViewName(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") {
      const fileName = parsed.pathname.split("/").pop() ?? "index.html";
      return fileName.replace(/\.html$/i, "") || "index";
    }
    const path = parsed.pathname || "/";
    return path.length > 120 ? `${path.slice(0, 120)}…` : path;
  } catch {
    return url.length > 120 ? `${url.slice(0, 120)}…` : url;
  }
}

/** Renderer Browser SDK init 配置（与主进程 endpoint/env/version 对齐） */
export function buildArmsBrowserInitConfig(runtimeEnv: LCodeRuntimeEnv) {
  return {
    enable: true,
    version: LCODE_VERSION,
    endpoint: LCODE_ARMS_RUM_ENDPOINT,
    env: mapLCodeEnvToArmsRumEnv(runtimeEnv),
    sessionConfig: {
      sampleRate: 1,
    },
    spaMode: false as const,
    parseViewName: parseArmsViewName,
    collectors: { ...ARMS_BROWSER_COLLECTORS },
  };
}
