import { recordArmsCustomEventForE2E } from "@lcode/ui";
import {
  DEFAULT_REMOTE_CONTROL_WORKER_BASE_URL,
  DEFAULT_REMOTE_CONTROL_PAIRING_TTL_MS,
  DesktopCommandIds,
  buildLocalMediaPreviewUrl,
  type IPlatformService,
} from "@lcode/shared";

import { desktopBrowserPlatformBridge } from "./desktopBrowserPlatformBridge.js";

// 手机远程控制桥的方法声明在 packages/client/src/globals.d.ts 的 window.lcode 上;
// renderer 仍只经 IPlatformService 消费,不直触私有通道。

export function createDesktopPlatform(options: {
  isLocalDevelopmentRuntime: boolean;
}): IPlatformService {
  return {
    canSelectFilePath: true,
    async writeClipboardText(text) {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard is unavailable");
      await navigator.clipboard.writeText(text);
    },
    createLocalMediaPreviewUrl: buildLocalMediaPreviewUrl,
    isLocalDevelopmentRuntime: options.isLocalDevelopmentRuntime,
    selectDirectory: () => window.lcode.selectDirectory(),
    selectFile: () => window.lcode.selectFile(),
    selectFiles: () => window.lcode.selectFiles?.() ?? Promise.resolve([]),
    createTempTextAttachment: (payload) => window.lcode.createTempTextAttachment(payload),
    onRemoteConnectionLog: (handler) => window.lcode.onRemoteConnectionLog(handler),
    onRemoteSessionClosed: (handler) => window.lcode.onRemoteSessionClosed(handler),
    activateOrSetWorkspace: (path) =>
      window.lcode.activateOrSetWorkspace?.(path) ?? Promise.resolve({ activated: false }),
    connectRemote: (remoteOptions, requestId, context) =>
      window.lcode.connectRemote(remoteOptions, requestId, context),
    cancelPendingRemoteConnection: (requestId) =>
      window.lcode.cancelPendingRemoteConnection?.(requestId) ?? Promise.resolve(),
    bindRemoteWorkspaceSessionContext: (context) =>
      window.lcode.bindRemoteWorkspaceSessionContext?.(context) ?? Promise.resolve(),
    disposeRemoteSession: (sessionId) => window.lcode.disposeRemoteSession(sessionId),
    startRemotePairing: window.lcode.startRemotePairing
      ? (request) => window.lcode.startRemotePairing!(request)
      : async () => ({ success: false, error: "not_supported" }),
    stopRemotePairing: window.lcode.stopRemotePairing
      ? () => window.lcode.stopRemotePairing!()
      : async () => {},
    decideRemotePairing: window.lcode.decideRemotePairing
      ? (request) => window.lcode.decideRemotePairing!(request)
      : async () => {},
    onRemotePairingState: window.lcode.onRemotePairingState
      ? (handler) => window.lcode.onRemotePairingState!(handler)
      : () => () => {},
    listRemoteDevices: window.lcode.listRemoteDevices
      ? () => window.lcode.listRemoteDevices!()
      : async () => ({ devices: [] }),
    revokeRemoteDevice: window.lcode.revokeRemoteDevice
      ? (deviceId) => window.lcode.revokeRemoteDevice!(deviceId)
      : async () => {},
    getRemoteControlConfig: window.lcode.getRemoteControlConfig
      ? () => window.lcode.getRemoteControlConfig!()
      : async () => ({
          enabled: false,
          workerBaseUrl: DEFAULT_REMOTE_CONTROL_WORKER_BASE_URL,
          hasAccessKey: false,
          // 缺省面复用 shared 常量,避免与 main 侧 persistSchema 默认值漂移。
          pairingTtlMs: DEFAULT_REMOTE_CONTROL_PAIRING_TTL_MS,
          allowNewDevices: true,
          idleDisconnectMs: 0,
          pairing: null,
          pairingUrl: null,
        }),
    setRemoteControlConfig: window.lcode.setRemoteControlConfig
      ? (request) => window.lcode.setRemoteControlConfig!(request)
      : async () => ({ success: false, error: "not_supported" }),
    // 可选能力:缺失时保持 undefined,bridge 侧 feature-detect 据此禁用「测试连接」按钮。
    testRemoteControlConnection: window.lcode.testRemoteControlConnection
      ? () => window.lcode.testRemoteControlConnection!()
      : undefined,
    isDockerAvailable: () => window.lcode.isDockerAvailable(),
    listWSLDistros: () => window.lcode.listWSLDistros(),
    listDockerContainers: () => window.lcode.listDockerContainers(),
    listSSHConfigAliases: () => window.lcode.listSSHConfigAliases(),
    loadMcpFromUserDirectory: (payload) => window.lcode.loadMcpFromUserDirectory(payload),
    saveMcpToUserDirectory: (payload) => window.lcode.saveMcpToUserDirectory(payload),
    migrateLegacyCommonMcp: (payload) => window.lcode.migrateLegacyCommonMcp(payload),
    openExternal: (url) => window.lcode.openExternal(url),
    openFeedback: () => window.lcode.executeDesktopCommand(DesktopCommandIds.OpenFeedback),
    openCommunity: () => window.lcode.executeDesktopCommand(DesktopCommandIds.OpenCommunity),
    canOpenCommunity: (locale) => window.lcode.canOpenCommunity(locale),
    openInFileManager: (path) => window.lcode.openInFileManager(path),
    openExternalFile: (path) => window.lcode.openExternalFile(path),
    openCuaPermissionOnboarding: window.lcode.openCuaPermissionOnboarding
      ? (permissionOptions) =>
          window.lcode.openCuaPermissionOnboarding?.(permissionOptions) ??
          Promise.resolve({ success: false, error: "not_supported" })
      : undefined,
    prepareCuaHelperPermissionDrag: window.lcode.prepareCuaHelperPermissionDrag
      ? () =>
          window.lcode.prepareCuaHelperPermissionDrag?.() ??
          Promise.resolve({ success: false, error: "not_supported" })
      : undefined,
    startCuaHelperPermissionDrag: window.lcode.startCuaHelperPermissionDrag
      ? () => window.lcode.startCuaHelperPermissionDrag?.()
      : undefined,
    registerOAuthState: (payload) => window.lcode.registerOAuthState(payload),
    onOAuthCallback: (callback) => window.lcode.onOAuthCallback(callback),
    onPaymentCallback: (callback) => window.lcode.onPaymentCallback(callback),
    onShareImport: (callback) => window.lcode.onShareImport?.(callback) ?? (() => {}),
    notifyRendererReady: () => window.lcode.notifyRendererReady(),
    reportTelemetryEvent: (payload) => window.lcode.reportTelemetryEvent(payload),
    reportArmsCustomEvent: (payload) => {
      recordArmsCustomEventForE2E(payload);
      return window.lcode.reportArmsCustomEvent(payload);
    },
    getRendererActionTraceConfig: window.lcode.getRendererActionTraceConfig
      ? () => window.lcode.getRendererActionTraceConfig!()
      : undefined,
    onRendererActionTraceConfigChanged: window.lcode.onRendererActionTraceConfigChanged
      ? (callback) => window.lcode.onRendererActionTraceConfigChanged!(callback)
      : undefined,
    reportLocalTtftBatch: (batch) => window.lcode.reportLocalTtftBatch(batch),
    reportRendererActionTraceBatch: window.lcode.reportRendererActionTraceBatch
      ? (batch) => window.lcode.reportRendererActionTraceBatch!(batch)
      : undefined,
    reportRendererHeapSample: window.lcode.reportRendererHeapSample
      ? (sample) => window.lcode.reportRendererHeapSample!(sample)
      : undefined,
    showTaskNotification: (payload) => window.lcode.showTaskNotification(payload),
    syncWindowTabs: (paths) => window.lcode.syncWindowTabs(paths),
    syncWindowUnreadCount: (count) => window.lcode.syncWindowUnreadCount(count),
    syncActiveTaskSession: (sessionId) => window.lcode.syncActiveTaskSession(sessionId),
    syncAppSettings: (patch) => window.lcode.syncAppSettings?.(patch),
    setShortcutRecordingActive: (active) => window.lcode.setShortcutRecordingActive?.(active),
    onFocusTab: (handler) => window.lcode.onFocusTab(handler),
    onNewTab: (handler) => window.lcode.onNewTab(handler),
    onCloseActiveContextRequest: (handler) =>
      window.lcode.onCloseActiveContextRequest?.(handler) ?? (() => {}),
    onOpenBrowserUrl: (handler) => window.lcode.onOpenBrowserUrl?.(handler) ?? (() => {}),
    onBrowserViewScreenshotSurfacePrepare: (handler) =>
      window.lcode.onBrowserViewScreenshotSurfacePrepare?.(handler) ?? (() => {}),
    onBrowserViewScreenshotSurfaceRelease: (handler) =>
      window.lcode.onBrowserViewScreenshotSurfaceRelease?.(handler) ?? (() => {}),
    browserViewScreenshotSurfaceReady: (payload) =>
      window.lcode.browserViewScreenshotSurfaceReady?.(payload),
    ...desktopBrowserPlatformBridge,
    onNewTask: (handler) => window.lcode.onNewTask(handler),
    onOpenWorkspace: (handler) => {
      // 开发态或升级后的旧窗口可能仍运行未暴露 onOpenWorkspace 的 preload，
      // renderer 直接调用会在启动时崩溃。这里和 activateOrSetWorkspace 一样做兼容兜底，
      // 缺少该 bridge 时只禁用原生菜单回调，不影响应用继续打开。
      return window.lcode.onOpenWorkspace?.(handler) ?? (() => {});
    },
    onOpenWorkspacePath: (handler) => window.lcode.onOpenWorkspacePath?.(handler) ?? (() => {}),
    onOpenFeedbackDialog: (handler) => window.lcode.onOpenFeedbackDialog?.(handler) ?? (() => {}),
    onOpenTicketsPanel: (handler) => window.lcode.onOpenTicketsPanel?.(handler) ?? (() => {}),
    onWindowFullscreenChanged: (handler) => window.lcode.onWindowFullscreenChanged(handler),
    getDesktopWindowChromeState: window.lcode.getDesktopWindowChromeState
      ? () => window.lcode.getDesktopWindowChromeState!()
      : undefined,
    onDesktopWindowChromeStateChanged: window.lcode.onDesktopWindowChromeStateChanged
      ? (handler) => window.lcode.onDesktopWindowChromeStateChanged!(handler)
      : undefined,
    getWindowControlsOverlayMetrics: () => window.lcode.getWindowControlsOverlayMetrics?.() ?? null,
    onWindowControlsOverlayChanged: (handler) =>
      window.lcode.onWindowControlsOverlayChanged?.(handler) ?? (() => {}),
    getDesktopZoomLevel: () =>
      window.lcode.getDesktopZoomLevel?.() ?? Promise.resolve({ zoomLevel: 0 }),
    onDesktopZoomLevelChanged: (handler) =>
      window.lcode.onDesktopZoomLevelChanged?.(handler) ?? (() => {}),
    onTaskNotificationClick: (handler) => window.lcode.onTaskNotificationClick(handler),
    exportLogs: () => window.lcode.exportLogs(),
    captureWindowScreenshot: () =>
      window.lcode.captureWindowScreenshot?.() ?? Promise.resolve(null),
    onUpdateReady: (callback) => window.lcode.onUpdateReady(callback),
    onUpdateCheckResult: (callback) => window.lcode.onUpdateCheckResult(callback),
    onUpdateStateChanged: (callback) => window.lcode.onUpdateStateChanged?.(callback) ?? (() => {}),
    getUpdateState: () =>
      window.lcode.getUpdateState?.() ?? Promise.resolve({ kind: "idle", enabled: true }),
    downloadUpdate: () => window.lcode.downloadUpdate?.() ?? Promise.resolve(),
    cancelUpdateDownload: () => window.lcode.cancelUpdateDownload?.() ?? Promise.resolve(),
    openUpdateStatusWindow: () => window.lcode.openUpdateStatusWindow?.() ?? Promise.resolve(),
    getAutoUpdatePreferences: () =>
      window.lcode.getAutoUpdatePreferences?.() ??
      Promise.resolve({ autoDownloadAndInstallUpdates: false }),
    setAutoDownloadAndInstallUpdates: (enabled) =>
      window.lcode.setAutoDownloadAndInstallUpdates?.(enabled) ?? Promise.resolve(),
    getDesktopSessionActivity: () =>
      window.lcode.getDesktopSessionActivity?.() ??
      Promise.resolve({ runningAgentSessionCount: 0 }),
    getLCodeStdioTapDevState: () =>
      window.lcode.getLCodeStdioTapDevState?.() ??
      Promise.resolve({ enabled: false, visible: false, logDir: "", statePath: "" }),
    onSettingsChanged: (callback) => window.lcode.onSettingsChanged?.(callback) ?? (() => {}),
    onApplicationLocaleChanged: (callback) =>
      window.lcode.onApplicationLocaleChanged?.(callback) ?? (() => {}),
    onPostUpdateReleaseNotes: (callback) => window.lcode.onPostUpdateReleaseNotes(callback),
    acknowledgePostUpdateReleaseNotes: (version) =>
      window.lcode.acknowledgePostUpdateReleaseNotes(version),
    skipUpdateVersion: (version) => window.lcode.skipUpdateVersion?.(version) ?? Promise.resolve(),
    quitAndInstallUpdate: () => window.lcode.quitAndInstallUpdate(),
    getInstalledEditors: () => window.lcode.getInstalledEditors(),
    getApplicationIcon: (bundleId) =>
      window.lcode.getApplicationIcon?.(bundleId) ?? Promise.resolve(null),
    openInEditor: (editorId, path, editorOptions) =>
      window.lcode.openInEditor(editorId, path, editorOptions),
    executeDesktopCommand: (command) => window.lcode.executeDesktopCommand(command),
    setApplicationLocale: (locale) => window.lcode.setApplicationLocale(locale),
    getSystemLocale: () =>
      window.lcode.getSystemLocale?.() ??
      Promise.resolve(navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US"),
    // preload 缺失（旧版本）时回退空串，UI 侧再回退默认名。
    getSystemUsername: async () => (await window.lcode.getSystemUsername?.()) ?? "",
    setTitleBarTheme: (theme) => window.lcode.setTitleBarTheme(theme),
    getDeviceId: () =>
      (window as Window & { __LCODE_DEVICE_ID__?: string }).__LCODE_DEVICE_ID__ ?? "",
  };
}
