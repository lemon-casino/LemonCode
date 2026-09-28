import type { BrowserCommand, BrowserCommandResult } from "@lcode/shared";
import {
  handleCheck,
  handleClick,
  handleCuaDrag,
  handleCuaKeypress,
  handleCuaScroll,
  handleDomCuaScroll,
  handleDrag,
  handleElementInfo,
  handleHover,
  handlePress,
  handleScroll,
  handleSelect,
  handleType,
} from "./browserCommandInteractionHandlers.js";
import {
  handleEvaluate,
  handleGetState,
  handleNavigate,
  handleScreenshot,
  handleSnapshot,
} from "./browserCommandPageHandlers.js";
import { now, readState } from "./browserCommandState.js";
import type { ControlledView } from "./browserCommandTypes.js";
import { handlePlaywrightAction } from "./browserPlaywrightExecutor.js";

export { isAllowedBrowserUrl } from "./browserCommandState.js";
export type {
  BrowserPoint,
  ControlledView,
  ControlledViewCdp,
  ControlledViewWebContents,
} from "./browserCommandTypes.js";

/**
 * 核心子集：navigate / getState / screenshot / snapshot / click / type / press / scroll；
 * 其余（fill/waitFor/capabilities）返回 capability_unsupported；playwrightWaitForTimeout 由
 * BrowserGuestManager 在校验 scope/tab 后处理，不进入页面 executor。
 * 抛错结构化返回，不 throw（保证 host↔main 桥能拿到结果）。
 */
export async function executeBrowserCommandOnView(
  view: ControlledView,
  command: BrowserCommand,
  opts?: { navigateSettleMs?: number; signal?: AbortSignal },
): Promise<BrowserCommandResult> {
  const startedAt = now();
  const done = (partial: Omit<BrowserCommandResult, "elapsedMs">): BrowserCommandResult => ({
    ...partial,
    elapsedMs: now() - startedAt,
  });

  try {
    switch (command.method) {
      case "navigate":
        return await handleNavigate(view, command, done, opts);
      case "getState":
        return await handleGetState(view, done);
      case "back":
        view.webContents.goBack();
        return done({ ok: true, state: readState(view.webContents) });
      case "forward":
        view.webContents.goForward();
        return done({ ok: true, state: readState(view.webContents) });
      case "reload":
        view.webContents.reload();
        return done({ ok: true, state: readState(view.webContents) });
      case "screenshot":
        return await handleScreenshot(view, command, done);
      case "snapshot":
        return await handleSnapshot(view, command, done);
      case "click":
        return await handleClick(view, command, done);
      case "type":
        return await handleType(view, command, done);
      case "press":
        return await handlePress(view, command, done);
      case "cuaKeypress":
        return await handleCuaKeypress(view, command, done);
      case "scroll":
        return await handleScroll(view, command, done);
      case "cuaScroll":
        return await handleCuaScroll(view, command, done);
      case "domCuaScroll":
        return await handleDomCuaScroll(view, command, done);
      case "hover":
        return await handleHover(view, command, done);
      case "select":
        return await handleSelect(view, command, done);
      case "check":
        return await handleCheck(view, command, done);
      case "drag":
        return await handleDrag(view, command, done);
      case "cuaDrag":
        return await handleCuaDrag(view, command, done);
      case "elementInfo":
        return await handleElementInfo(view, command, done);
      case "evaluate":
        return await handleEvaluate(view, command, done);
      case "playwright":
        return await handlePlaywrightAction(view, command.action, done, opts?.signal);
      default:
        // fill/waitFor/capabilities/getDialog/handleDialog/close/list/playwrightWaitForTimeout
        // 未在本 executor 实现（由 manager 层或后续增量处理）。
        return done({
          ok: false,
          error: {
            code: "capability_unsupported",
            message: `command ${command.method} is not supported by executor (available: navigate/getState/back/forward/reload/screenshot/snapshot/click/type/press/scroll/hover/select/check/drag/elementInfo/evaluate)`,
          },
        });
    }
  } catch (error) {
    // AbortError 表示调用方主动终止当前 generation。过去统一包装成 execution_error，
    // 会让上层误判为页面或 Playwright 执行失败，无法按取消生命周期清理请求。
    const cancelled =
      opts?.signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
    const timedOut =
      !cancelled &&
      error instanceof Error &&
      (error.name === "TimeoutError" || /\b(?:timed out|timeout exceeded)\b/iu.test(error.message));
    return done({
      ok: false,
      error: {
        code: cancelled ? "cancelled" : timedOut ? "timeout" : "execution_error",
        message: cancelled
          ? "Browser command cancelled"
          : error instanceof Error
            ? error.message
            : String(error),
      },
    });
  }
}
