import type {
  BrowserViewportSize,
  BrowserViewScreenshotSurfacePreparePayload,
  BrowserViewScreenshotSurfaceReleasePayload,
  BrowserViewSurfaceScaleMode,
} from "@lcode/shared";

const VIEWPORT_TOLERANCE_PX = 1;

export interface BrowserScreenshotActivityLease {
  readonly invalidated?: AbortSignal;
  markPrepared?(): void;
  release(): void;
}

export interface BrowserScreenshotSurfaceLease {
  readonly invalidated?: AbortSignal;
  surfaceScale: number;
  webContentsId: number;
  viewport: BrowserViewportSize;
  release(): void;
}

export interface BrowserScreenshotSurfaceCoordinator {
  prepare(input: {
    requestId: string;
    windowId: number;
    workspaceKey: string;
    sessionId: string;
    browserId: string;
    browserGeneration: number;
    tabId: string;
    webContentsId: number;
    viewport: BrowserViewportSize;
    viewportMode?: BrowserViewScreenshotSurfacePreparePayload["viewportMode"];
    /** recording 用真实 100% renderer surface；普通截图缺失时保留当前预览比例。 */
    surfaceScaleMode?: BrowserViewSurfaceScaleMode;
    signal: AbortSignal;
    /** recording 可显式请求更长但仍有界的 activity watchdog；普通截图继续使用默认值。 */
    activityTimeoutMs?: number;
  }): Promise<BrowserScreenshotSurfaceLease>;
}

export type BrowserScreenshotSurfacePrepareInput = Parameters<
  BrowserScreenshotSurfaceCoordinator["prepare"]
>[0];

export interface BrowserScreenshotPendingRequest {
  input: BrowserScreenshotSurfacePrepareInput;
  group: BrowserScreenshotPreparationGroup;
  resolve: (lease: BrowserScreenshotSurfaceLease) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abortListener: () => void;
}

export interface BrowserScreenshotPreparationGroup {
  key: string;
  payload: BrowserViewScreenshotSurfacePreparePayload;
  windowId: number;
  requests: Set<BrowserScreenshotPendingRequest>;
  prepareSent: boolean;
  ready: boolean;
  released: boolean;
  senderWebContentsId?: number;
  readySurfaceScale?: number;
  readyViewport?: BrowserViewportSize;
  leaseReleases: Set<() => void>;
  invalidationController: AbortController;
  activityLease?: BrowserScreenshotActivityLease;
  activityAbortListener?: () => void;
  activityTimer?: ReturnType<typeof setTimeout>;
  activityTimeoutMs?: number;
}

export function sameBrowserScreenshotViewport(
  expected: BrowserViewportSize,
  actual: BrowserViewportSize,
): boolean {
  return (
    Math.abs(expected.width - actual.width) <= VIEWPORT_TOLERANCE_PX &&
    Math.abs(expected.height - actual.height) <= VIEWPORT_TOLERANCE_PX
  );
}

export function releaseBrowserScreenshotResourceOnce(callback: () => void): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    callback();
  };
}

export function toBrowserScreenshotSurfacePreparePayload(
  input: BrowserScreenshotSurfacePrepareInput,
  timeoutMs: number,
): BrowserViewScreenshotSurfacePreparePayload {
  return {
    requestId: input.requestId,
    workspaceKey: input.workspaceKey,
    sessionId: input.sessionId,
    browserId: input.browserId,
    browserGeneration: input.browserGeneration,
    tabId: input.tabId,
    webContentsId: input.webContentsId,
    viewport: input.viewport,
    ...(input.viewportMode ? { viewportMode: input.viewportMode } : {}),
    ...(input.surfaceScaleMode ? { surfaceScaleMode: input.surfaceScaleMode } : {}),
    timeoutMs,
  };
}

export function toBrowserScreenshotSurfaceReleasePayload(
  payload: BrowserViewScreenshotSurfacePreparePayload,
): BrowserViewScreenshotSurfaceReleasePayload {
  const {
    surfaceScaleMode: _surfaceScaleMode,
    timeoutMs: _timeoutMs,
    viewport: _viewport,
    viewportMode: _viewportMode,
    ...releasePayload
  } = payload;
  return releasePayload;
}
