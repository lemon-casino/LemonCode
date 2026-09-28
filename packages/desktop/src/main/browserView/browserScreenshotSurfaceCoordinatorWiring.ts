import { PlatformChannels } from "@lcode/shared";
import { DesktopBrowserScreenshotActivityController } from "./browserScreenshotActivityController.js";
import { DesktopBrowserScreenshotSurfaceCoordinator } from "./browserScreenshotSurfaceCoordinator.js";

interface BrowserWindowForScreenshotSurface {
  isDestroyed(): boolean;
  webContents: {
    id: number;
    isDestroyed(): boolean;
    capturePage(rect: { x: number; y: number; width: number; height: number }): Promise<unknown>;
    send(channel: string, payload: unknown): void;
  };
}

interface GuestWebContentsForScreenshotActivity {
  id: number;
  isDestroyed(): boolean;
  readonly hostWebContents: { id: number } | null;
  capturePage(rect: { x: number; y: number; width: number; height: number }): Promise<unknown>;
}

/** 将截图表面协调器绑定到 owner BrowserWindow；协调器本身不依赖 Electron 全局对象，便于测试。 */
export function createDesktopBrowserScreenshotSurfaceCoordinator(options: {
  fromId(windowId: number): BrowserWindowForScreenshotSurface | null;
  fromWebContentsId(webContentsId: number): GuestWebContentsForScreenshotActivity | null;
  log?(message: string): void;
  warn?(message: string): void;
  timeoutMs?: number;
  activityTimeoutMs?: number;
  allowTransparentWindowBootstrap?: boolean;
  hideTaskbarDuringTransparentWindowBootstrap?: boolean;
}): DesktopBrowserScreenshotSurfaceCoordinator {
  const activityController = new DesktopBrowserScreenshotActivityController({
    fromId: options.fromId,
    fromWebContentsId: options.fromWebContentsId,
    allowTransparentWindowBootstrap:
      options.allowTransparentWindowBootstrap ??
      (process.platform === "darwin" || process.platform === "win32"),
    hideTaskbarDuringTransparentWindowBootstrap:
      options.hideTaskbarDuringTransparentWindowBootstrap ?? process.platform === "win32",
    log: options.log,
  });
  return new DesktopBrowserScreenshotSurfaceCoordinator({
    timeoutMs: options.timeoutMs,
    activityTimeoutMs: options.activityTimeoutMs,
    acquireActivity: (windowId, payload) =>
      activityController.acquire({
        windowId,
        webContentsId: payload.webContentsId,
        requestId: payload.requestId,
        reason: "browser-screenshot",
      }),
    sendPrepare: (windowId, payload) => {
      const win = options.fromId(windowId);
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
        options.log?.("[browser-screenshot-surface] prepare skipped for destroyed owner window");
        return false;
      }
      try {
        win.webContents.send(PlatformChannels.BrowserViewScreenshotSurfacePrepare, payload);
        return true;
      } catch {
        // Electron 窗口关闭期间 send 可能同步抛错；prepare 必须转成受控失败，不能泄漏到主进程。
        options.log?.("[browser-screenshot-surface] prepare send failed");
        return false;
      }
    },
    sendRelease: (windowId, payload) => {
      const win = options.fromId(windowId);
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
        options.log?.("[browser-screenshot-surface] release skipped for destroyed owner window");
        return;
      }
      try {
        win.webContents.send(PlatformChannels.BrowserViewScreenshotSurfaceRelease, payload);
      } catch {
        // release 运行在 timeout/dispose/lease finally 中，绝不能反向抛出打断主进程清理。
        options.log?.("[browser-screenshot-surface] release send failed");
      }
    },
    log: options.log,
    warn: options.warn,
  });
}
