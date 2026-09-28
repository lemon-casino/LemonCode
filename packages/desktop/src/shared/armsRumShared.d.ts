import { type LCodeRuntimeEnv } from "@lcode/shared";
/** 主进程 init 的 browserCollectors，经 autoInject 注入到 renderer 的 RumSDK.init(collectors) */
export declare const ARMS_BROWSER_COLLECTORS: {
  readonly perf: true;
  readonly webvitals: true;
  readonly exception: true;
  readonly whiteScreen: true;
  readonly api: true;
  readonly staticResource: true;
  readonly click: true;
  readonly longTask: true;
};
/** ARMS 页面名解析：file:// 与 dev-server 统一规则，主进程 parseViewName 与 renderer 共用 */
export declare function parseArmsViewName(url: string): string;
/** Renderer Browser SDK init 配置（与主进程 endpoint/env/version 对齐） */
export declare function buildArmsBrowserInitConfig(runtimeEnv: LCodeRuntimeEnv): {
  enable: boolean;
  version: string;
  endpoint: string;
  env: import("@lcode/shared").ArmsRumEnv;
  sessionConfig: {
    sampleRate: number;
  };
  spaMode: false;
  parseViewName: typeof parseArmsViewName;
  collectors: {
    perf: true;
    webvitals: true;
    exception: true;
    whiteScreen: true;
    api: true;
    staticResource: true;
    click: true;
    longTask: true;
  };
};
//# sourceMappingURL=armsRumShared.d.ts.map
