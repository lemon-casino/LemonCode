import type { BrowserPageState } from "@lcode/shared";
import type { ControlledViewWebContents } from "./browserCommandTypes.js";

/**
 * 导航命令的默认导航预算为 10s。超时/真实 loadURL 错误必须返回失败，
 * 不能吞错后伪造成功；否则模型会在错误页面上继续构造 locator。
 */
export const DEFAULT_NAVIGATE_SETTLE_MS = 10_000;

export class BrowserNavigationTimeoutError extends Error {
  override name = "BrowserNavigationTimeoutError";
}

/**
 * 浏览器导航白名单：只允许 http/https 与精确的 about:blank。
 * 不能放行任意 about:*。
 */
export function isAllowedBrowserUrl(rawUrl: string): boolean {
  if (rawUrl === "about:blank") return true;
  try {
    const u = new URL(rawUrl);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function now(): number {
  return Date.now();
}

export function readState(wc: ControlledViewWebContents): BrowserPageState {
  return {
    url: safe(() => wc.getURL(), ""),
    title: safe(() => wc.getTitle(), ""),
    canGoBack: safe(() => wc.canGoBack(), false),
    canGoForward: safe(() => wc.canGoForward(), false),
  };
}

/** loadURL 与超时/取消竞速；只有真实完成才算导航成功。 */
export async function settleNavigation(
  loadPromise: Promise<void>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new BrowserNavigationTimeoutError(`Navigation timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException("aborted", "AbortError"));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([loadPromise, timeout, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
