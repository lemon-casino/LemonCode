import type { BrowserCommand, BrowserCommandResult } from "@lcode/shared";
import { browserSnapshotSchema } from "@lcode/shared";
import { EVALUATE_SCRIPT, SNAPSHOT_SCRIPT, VIEWPORT_SCRIPT } from "./browserCommandScripts.js";
import {
  DEFAULT_NAVIGATE_SETTLE_MS,
  BrowserNavigationTimeoutError,
  isAllowedBrowserUrl,
  readState,
  settleNavigation,
} from "./browserCommandState.js";
import type { ControlledView } from "./browserCommandTypes.js";
import type { BrowserCommandDone } from "./browserCommandResult.js";
import { executionError } from "./browserCommandResult.js";
import { captureScreenshotWithCssPixelCorrection } from "./browserScreenshotCapture.js";

const ABORTED_NAVIGATION_CONFIRM_TIMEOUT_MS = 500;
const ABORTED_NAVIGATION_POLL_INTERVAL_MS = 25;

interface ScreenshotViewportMetrics {
  pageX?: number;
  pageY?: number;
  clientWidth?: number;
  clientHeight?: number;
}

interface ScreenshotContentMetrics {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

interface ScreenshotLayoutMetrics {
  layoutViewport?: ScreenshotViewportMetrics;
  visualViewport?: ScreenshotViewportMetrics;
  contentSize?: ScreenshotContentMetrics;
  cssLayoutViewport?: ScreenshotViewportMetrics;
  cssVisualViewport?: ScreenshotViewportMetrics;
  cssContentSize?: ScreenshotContentMetrics;
}

interface ScreenshotCssViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function readScreenshotLayoutMetrics(view: ControlledView): Promise<ScreenshotLayoutMetrics> {
  return (await view.cdp.send("Page.getLayoutMetrics")) as ScreenshotLayoutMetrics;
}

function resolveScreenshotCssViewport(
  metrics: ScreenshotLayoutMetrics,
): ScreenshotCssViewport | null {
  const cssViewport = metrics.cssVisualViewport ?? metrics.cssLayoutViewport;
  const cssWidth = cssViewport?.clientWidth;
  const cssHeight = cssViewport?.clientHeight;
  if (
    typeof cssWidth !== "number" ||
    !Number.isFinite(cssWidth) ||
    cssWidth <= 0 ||
    typeof cssHeight !== "number" ||
    !Number.isFinite(cssHeight) ||
    cssHeight <= 0
  ) {
    return null;
  }
  return {
    x: typeof cssViewport?.pageX === "number" ? cssViewport.pageX : 0,
    y: typeof cssViewport?.pageY === "number" ? cssViewport.pageY : 0,
    width: cssWidth,
    height: cssHeight,
  };
}

export async function buildViewportScreenshotParams(
  view: ControlledView,
): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = {
    format: "png",
    captureBeyondViewport: false,
  };
  if (!view.normalizeScreenshotToCssPixels) return params;
  const cssViewport = resolveScreenshotCssViewport(await readScreenshotLayoutMetrics(view));
  if (!cssViewport) return params;
  // legacy layout metrics 在 Retina guest 中可以是 CSS viewport 的 2 倍，
  // 但 capture raster 已经是 CSS 1x。首帧预先套用 0.5 会产生 640×360，并可能让重挂载的
  // guest compositor 停留在左上角。首帧固定使用 CSS 1x，实际 PNG 异常再由共用执行器校正。
  params.clip = { ...cssViewport, scale: 1 };
  return params;
}

function isElectronNavigationAborted(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    errno?: unknown;
    message?: unknown;
  };
  return (
    candidate.code === "ERR_ABORTED" ||
    candidate.errno === -3 ||
    (typeof candidate.message === "string" && /\bERR_ABORTED\b|\(-3\)/u.test(candidate.message))
  );
}

function normalizedHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^(?:m|www)\./u, "");
}

function normalizedPath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/u, "") : pathname;
}

function isEquivalentNavigationUrl(requestedUrl: string, currentUrl: string): boolean {
  try {
    const requested = new URL(requestedUrl);
    const current = new URL(currentUrl);
    if (requested.protocol === "about:" || current.protocol === "about:") {
      return requested.href === current.href;
    }
    return (
      requested.protocol === current.protocol &&
      normalizedHost(requested.hostname) === normalizedHost(current.hostname) &&
      requested.port === current.port &&
      normalizedPath(requested.pathname) === normalizedPath(current.pathname) &&
      requested.search === current.search
    );
  } catch {
    return false;
  }
}

async function confirmAbortedNavigationCommitted(
  view: ControlledView,
  requestedUrl: string,
  previousUrl: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + ABORTED_NAVIGATION_CONFIRM_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    try {
      const documentState = (await view.webContents.executeJavaScript(`(() => ({
        href: globalThis.location?.href ?? "",
        readyState: document.readyState
      }))()`)) as { href?: unknown; readyState?: unknown } | null;
      const currentUrl = view.webContents.getURL();
      const href = typeof documentState?.href === "string" ? documentState.href : "";
      const readyState = documentState?.readyState;
      if (
        currentUrl !== previousUrl &&
        href === currentUrl &&
        (readyState === "interactive" || readyState === "complete") &&
        isEquivalentNavigationUrl(requestedUrl, currentUrl)
      ) {
        return true;
      }
    } catch {
      // guest 正在切换 document 时 executeJavaScript 可能短暂失败；在有界窗口内继续复核。
    }
    await new Promise<void>((resolve) => setTimeout(resolve, ABORTED_NAVIGATION_POLL_INTERVAL_MS));
  }
  return false;
}

export async function handleNavigate(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "navigate" }>,
  done: BrowserCommandDone,
  opts?: { navigateSettleMs?: number; signal?: AbortSignal },
): Promise<BrowserCommandResult> {
  if (!isAllowedBrowserUrl(command.url)) {
    return done({
      ok: false,
      error: { code: "navigation_blocked", message: `Blocked URL: ${command.url}` },
    });
  }
  const previousUrl = view.webContents.getURL();
  try {
    await settleNavigation(
      view.webContents.loadURL(command.url),
      opts?.navigateSettleMs ?? DEFAULT_NAVIGATE_SETTLE_MS,
      opts?.signal,
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    // 站点的 www→m 重定向或 SPA 路由接管会让 Electron loadURL 以
    // ERR_ABORTED reject，但新 document 已经提交。只在 URL 等价且 document ready 时认定成功；
    // 不能把已成功导航的页面回报成硬失败，诱导模型继续猜 URL/资源 ID。
    if (
      isElectronNavigationAborted(error) &&
      (await confirmAbortedNavigationCommitted(view, command.url, previousUrl, opts?.signal))
    ) {
      return done({ ok: true, state: readState(view.webContents) });
    }
    return done({
      ok: false,
      error: {
        code: error instanceof BrowserNavigationTimeoutError ? "timeout" : "execution_error",
        message: error instanceof Error ? error.message : String(error),
        sideEffect: "uncertain",
      },
    });
  }
  return done({ ok: true, state: readState(view.webContents) });
}

export async function handleGetState(
  view: ControlledView,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  const state = readState(view.webContents);
  // 补 scrollX/scrollY/viewportWidth/viewportHeight（读取失败不致命，返回基础 state）。
  try {
    const raw = (await view.webContents.executeJavaScript(VIEWPORT_SCRIPT)) as {
      scrollX?: unknown;
      scrollY?: unknown;
      innerWidth?: unknown;
      innerHeight?: unknown;
    } | null;
    if (raw && typeof raw === "object") {
      if (typeof raw.scrollX === "number") state.scrollX = raw.scrollX;
      if (typeof raw.scrollY === "number") state.scrollY = raw.scrollY;
      if (typeof raw.innerWidth === "number") state.viewportWidth = raw.innerWidth;
      if (typeof raw.innerHeight === "number") state.viewportHeight = raw.innerHeight;
    }
  } catch {
    /* 读取视口信息失败时保留基础 state。 */
  }
  return done({ ok: true, state });
}

export async function handleScreenshot(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "screenshot" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  if (command.clip === undefined && command.fullPage !== true && view.captureViewportScreenshot) {
    const data = await view.captureViewportScreenshot();
    if (!data) {
      return done({
        ok: false,
        error: { code: "execution_error", message: "screenshot returned empty data" },
      });
    }
    return done({
      ok: true,
      image: { base64: data, mimeType: "image/png" },
      state: readState(view.webContents),
    });
  }

  // 走 CDP Page.captureScreenshot（规避 renderer webContents.capturePage 的 V8 FATAL，且拿全页）。
  const metrics =
    command.fullPage === true || view.normalizeScreenshotToCssPixels
      ? await readScreenshotLayoutMetrics(view)
      : null;
  const cssViewport =
    view.normalizeScreenshotToCssPixels && metrics ? resolveScreenshotCssViewport(metrics) : null;
  const params: Record<string, unknown> = {
    format: "png",
    // 普通 viewport 截图不应走 viewport 外的 compositor surface；clip/fullPage 才显式允许。
    captureBeyondViewport: command.clip !== undefined || command.fullPage === true,
  };
  if (command.clip) {
    // 区域截图：clip 用视口 CSS px，scale:1 保证与坐标同系。
    params.clip = {
      x: command.clip.x,
      y: command.clip.y,
      width: command.clip.width,
      height: command.clip.height,
      scale: 1,
    };
  } else if (command.fullPage === true) {
    // 全页截图：取 contentSize（优先 CSS 尺寸），用 clip 覆盖整页。
    const cs = metrics?.cssContentSize ?? metrics?.contentSize;
    if (cs && typeof cs.width === "number" && typeof cs.height === "number") {
      params.clip = {
        x: typeof cs.x === "number" ? cs.x : 0,
        y: typeof cs.y === "number" ? cs.y : 0,
        width: cs.width,
        height: cs.height,
        scale: 1,
      };
    }
  } else if (cssViewport) {
    params.clip = { ...cssViewport, scale: 1 };
  }

  const res = await captureScreenshotWithCssPixelCorrection(view, params);
  if (!res?.data) {
    return done({
      ok: false,
      error: { code: "execution_error", message: "screenshot returned empty data" },
    });
  }
  return done({
    ok: true,
    image: { base64: res.data, mimeType: "image/png" },
    state: readState(view.webContents),
  });
}

export async function handleSnapshot(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "snapshot" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  // 注入脚本遍历可见 DOM，产出带 ref 的结构化快照（严格对齐 browserSnapshotSchema）。
  const raw = await view.webContents.executeJavaScript(
    SNAPSHOT_SCRIPT(command.maxElements, command.includeHidden),
  );
  // 防御式校验：脚本受控但异形页面可能覆写 getter/返回残缺结构。safeParse 失败时
  // 转成明确的 execution_error（而非把畸形对象透传到下游让 strict zod 报笼统失败）。
  const parsed = browserSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    return done({
      ok: false,
      error: {
        code: "execution_error",
        message: `invalid snapshot result shape: ${parsed.error.issues[0]?.message ?? "unknown"}`,
      },
    });
  }
  return done({ ok: true, snapshot: parsed.data });
}

export async function handleEvaluate(
  view: ControlledView,
  command: Extract<BrowserCommand, { method: "evaluate" }>,
  done: BrowserCommandDone,
): Promise<BrowserCommandResult> {
  // 执行页面表达式并 JSON 安全序列化；异常 → execution_error。
  const raw = (await view.webContents.executeJavaScript(EVALUATE_SCRIPT(command.expression))) as {
    ok?: boolean;
    kind?: string;
    data?: string;
    message?: string;
  } | null;
  if (!raw || typeof raw !== "object")
    return done(executionError("evaluate returned invalid result"));
  if (raw.ok === false) return done(executionError(raw.message ?? "evaluate error"));

  let value: unknown;
  if (raw.kind === "json" && typeof raw.data === "string") {
    try {
      value = JSON.parse(raw.data);
    } catch {
      // 理论不达（页面侧已 JSON.stringify 成功）；兜底透传原字符串。
      value = raw.data;
    }
  } else {
    value = raw.data;
  }
  return done({ ok: true, value });
}
