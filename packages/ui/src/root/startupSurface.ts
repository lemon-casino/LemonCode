import type { StartupSurface } from "@lcode/shared";

/** 只投影已有门禁；缺少实际 workspace 的首帧不能提前揭示空壳。 */
export function resolveStartupSurface(state: {
  blocked: boolean;
  hasWorkspace: boolean;
  attention: boolean;
  welcome?: boolean;
}): StartupSurface {
  return state.attention
    ? "attention"
    : state.welcome
      ? "welcome"
      : state.blocked || !state.hasWorkspace
        ? "loading"
        : "ready";
}
