import { DatabaseStartupAdmission } from "./databaseStartupAdmission.js";
import { initializeDesktopLocalTtft } from "./localTtftBootstrap.js";
import { createRoot } from "react-dom/client";
import { useEffect } from "react";
import {
  AppErrorBoundary,
  Root,
  GlobalDatabaseStartupLoading,
  UpdateStatusWindowRoot,
  ZCodeIntlProvider,
  registerBaseWorkspaceServices,
  registerRemoteWorkspaceSession,
  createRemoteWorkspaceDisconnectedError,
  playTaskNotificationSound,
  setStreamClientId,
  setReactErrorArmsReporter,
} from "@zcode/ui";
import "@zcode/ui/styles.css";
import { connectViaMessagePort, createMessagePortServiceConnection } from "@zcode/client";
import {
  InternalChannels,
  databaseStartupStateSchema,
  type DatabaseStartupControl,
  collectTelemetryRendererContext,
  parseLaunchMarks,
  LAUNCH_MARKS_QUERY_KEY,
  type LaunchMarks,
  DEFAULT_LOCALE,
} from "@zcode/shared";
import type { Locale } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { syncAppTelemetryContext } from "../appTelemetryBridge.js";
import { createDesktopPlatform } from "./desktopPlatform.js";
import { startPerformanceTimelineCleanup } from "./performanceTimelineCleanup.js";
import { initializeDesktopUserActionTrace } from "./userActionTraceBootstrap.js";
import { buildRemoteWorkspaceSessionServices } from "./remoteWorkspaceSessionServices.js";
import {
  notifyRemoteWorkspaceServicePortReady,
  parseRemoteWorkspaceServicePortMessage,
  type RemoteWorkspaceServicePortRegistration,
} from "./remoteWorkspaceServicePortBridge.js";

type DesktopRendererImportMetaEnv = {
  VITE_ZCODE_E2E_STORE_BRIDGE?: string;
};

startPerformanceTimelineCleanup();

// T4:renderer bundle 开始执行。同时从 loadURL query 解析 main 注入的 T0-T3。
const rendererStartedAt = Date.now();
const launchMarks: LaunchMarks | null = parseLaunchMarks(
  new URLSearchParams(window.location.search).get(LAUNCH_MARKS_QUERY_KEY),
);
(
  window as Window & {
    __ZCODE_RENDERER_START__?: number;
    __ZCODE_LAUNCH_MARKS__?: LaunchMarks | null;
  }
).__ZCODE_RENDERER_START__ = rendererStartedAt;
(window as Window & { __ZCODE_LAUNCH_MARKS__?: LaunchMarks | null }).__ZCODE_LAUNCH_MARKS__ =
  launchMarks;
registerE2EStoreBridgesIfEnabled();

function registerE2EStoreBridgesIfEnabled() {
  const env = ((import.meta as ImportMeta & { env?: DesktopRendererImportMetaEnv }).env ??
    {}) as DesktopRendererImportMetaEnv;
  if (env.VITE_ZCODE_E2E_STORE_BRIDGE !== "1") {
    return;
  }

  void import("@zcode/ui/e2e-store-bridge").then(({ registerE2EStoreBridges }) => {
    registerE2EStoreBridges();
  });
}

// 初始化主题：默认 Zai dark，后续由 useTheme hook 接管。
// 首帧写点与 useTheme.ts 的 THEME_OPTIONS 注册表保持同步（新增主题需同步此处）：
// 深基底挂 dark + theme-<id>、浅基底只挂 theme-<id>，让 React 接管前即呈现新主题差量色，
// 避免先见基底色再跳变；异常本地值回落默认 zai-dark。
{
  // 主题 id → 明暗基底（useTheme.ts THEME_OPTIONS 静态子集的引导映射）。
  const BOOTSTRAP_THEME_BASES = {
    "zai-light": "light",
    "zai-dark": "dark",
    "sepia-light": "light",
    "midnight-blue": "dark",
    "forest-dark": "dark",
  } as const;
  type BootstrapAppliedTheme = keyof typeof BOOTSTRAP_THEME_BASES;
  const isBootstrapAppliedTheme = (value: string): value is BootstrapAppliedTheme =>
    value in BOOTSTRAP_THEME_BASES;

  const saved = localStorage.getItem("zcode-theme") || "zai-dark";
  const appliedTheme: BootstrapAppliedTheme =
    saved === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "zai-dark"
        : "zai-light"
      : saved === "dark"
        ? "zai-dark"
        : saved === "light"
          ? "zai-light"
          : isBootstrapAppliedTheme(saved)
            ? saved
            : "zai-dark";
  document.documentElement.classList.toggle(
    "dark",
    BOOTSTRAP_THEME_BASES[appliedTheme] === "dark",
  );
  // toggle 其余 theme-* 为 false 等价清空，防 reload/HMR 时残留上一个主题类。
  for (const themeId of Object.keys(BOOTSTRAP_THEME_BASES)) {
    document.documentElement.classList.toggle(`theme-${themeId}`, themeId === appliedTheme);
  }
}

const isMacDesktop = navigator.userAgent.includes("Mac");
const isWindowsDesktop = navigator.userAgent.includes("Windows");
const isLinuxDesktop = !isMacDesktop && !isWindowsDesktop;
// macOS hidden 原生标题栏仍参与鼠标拖拽命中，深层浮层需要平台标记避开其高度。
document.documentElement.classList.toggle("platform-mac-desktop", isMacDesktop);
// Windows 的原生 titleBarOverlay 与 renderer 共用右上角，深层浮层拿不到
// Root 的 isWindowsDesktop prop 时会把关闭按钮放进原生窗控命中区。根节点平台标记只描述
// Desktop chrome，不会让普通 Windows Web 误用标题栏安全区。
document.documentElement.classList.toggle("platform-windows-desktop", isWindowsDesktop);
// Linux 的窗口标题栏由 renderer 自绘，应用内 Dialog overlay 如果覆盖整个 webContents，
// 会把标题栏点击区一起拦截。给桌面 Linux 根节点打平台标记，让 UI overlay 能只在 Linux 避开标题栏。
document.documentElement.classList.toggle("platform-linux-desktop", isLinuxDesktop);
const isLocalDevelopmentRuntime =
  (globalThis as typeof globalThis & { __ZCODE_LOCAL_DEVELOPMENT_RUNTIME__?: boolean })
    .__ZCODE_LOCAL_DEVELOPMENT_RUNTIME__ === true;

function readBooleanFlag(name: string, defaultValue: boolean): boolean {
  const value = new URLSearchParams(window.location.search).get(name);
  if (value == null) return defaultValue;
  return value !== "false" && value !== "0";
}

function readStringFlag(name: string): string | undefined {
  const value = new URLSearchParams(window.location.search).get(name);
  return value == null || value.trim() === "" ? undefined : value;
}

const restoreSession = readBooleanFlag("restoreSession", true);
const supportsSettings = readBooleanFlag("supportsSettings", true);
const initialWorkspaceAbsPath = readStringFlag("initialWorkspacePath");
const initialWorkspacePurpose = readStringFlag("initialWorkspacePurpose");
const unavailableWorkspacePath = readStringFlag("unavailableWorkspacePath");
const windowKind = readStringFlag("windowKind");
const initialLocaleFlag = readStringFlag("locale");
const initialLocale: Locale =
  initialLocaleFlag === "zh-CN" || initialLocaleFlag === "en-US"
    ? initialLocaleFlag
    : DEFAULT_LOCALE;
let baseServicesForRemoteSessions: IServiceAccessor | null = null;
const pendingRemoteWorkspaceServicePorts: RemoteWorkspaceServicePortRegistration[] = [];

const desktopPlatform = createDesktopPlatform({ isLocalDevelopmentRuntime });
initializeDesktopLocalTtft(desktopPlatform);
initializeDesktopUserActionTrace({
  platform: desktopPlatform,
  isLocalDevelopmentRuntime,
});

/**
 * 等待 preload 通过 window.postMessage 转发 MessagePort。
 *
 * MessagePort 不能经过 contextBridge（会丢失原生方法），
 * 所以 preload 用 window.postMessage + transfer 把 port 原样传递到 renderer。
 * 本地窗口的 port 来自 utilityProcess，远程窗口也一样，renderer 无需区分。
 */
// 之前用匿名函数注册 addEventListener("message")，reload/HMR 时会重复注册，
// 导致多次 createRoot 在同一 DOM 节点上挂载。用 flag 防止重复初始化。
let appInitialized = false;
const databaseStartupAdmission = new DatabaseStartupAdmission();
const appRoot =
  windowKind === "update-status" ? null : createRoot(document.getElementById("root")!);
const sendStartupControl = (control: DatabaseStartupControl) =>
  window.postMessage({ type: InternalChannels.DatabaseStartupControl, control }, "*");
function renderDatabaseStartup(): void {
  appRoot?.render(
    <AppErrorBoundary isDesktop isMacDesktop={isMacDesktop} isWindowsDesktop={isWindowsDesktop}>
      <ZCodeIntlProvider
        initialLocale={initialLocaleFlag ? initialLocale : undefined}
        resolveSystemLocale={desktopPlatform.getSystemLocale}
      >
        <StartupReadyNotifier />
        <GlobalDatabaseStartupLoading
          state={databaseStartupAdmission.state}
          onRetry={() => {
            if (databaseStartupAdmission.state)
              sendStartupControl({
                action: "retry",
                attemptId: databaseStartupAdmission.state.attemptId,
              });
          }}
          onCopy={(details) => navigator.clipboard.writeText(details)}
          onExit={() => sendStartupControl({ action: "exit" })}
        />
      </ZCodeIntlProvider>
    </AppErrorBoundary>,
  );
}
function enterAppIfPrepared(): void {
  if (appInitialized) return;
  const port = databaseStartupAdmission.takeReadyPort();
  if (port) initializeBusinessRoot(port);
}
const firstStartupStateTimer =
  windowKind === "update-status"
    ? undefined
    : setTimeout(() => {
        if (databaseStartupAdmission.state) return;
        const now = Date.now();
        databaseStartupAdmission.state = {
          schemaVersion: 1,
          startupId: "unavailable",
          attemptId: "startup-channel-unavailable",
          sequence: 0,
          startedAt: rendererStartedAt,
          updatedAt: now,
          phase: "failed",
          errorCode: "startup_status_timeout",
          disk: [],
        };
        renderDatabaseStartup();
      }, 30_000);

function registerRemoteWorkspaceServicePort(params: RemoteWorkspaceServicePortRegistration) {
  if (!baseServicesForRemoteSessions) {
    return;
  }

  const remoteConnection = createMessagePortServiceConnection(params.port);
  const remoteServices = remoteConnection.services;
  const services = buildRemoteWorkspaceSessionServices(
    baseServicesForRemoteSessions,
    remoteServices,
  );
  registerRemoteWorkspaceSession({
    sessionId: params.sessionId,
    target: params.target,
    services,
    dispose: (reason) =>
      remoteConnection.dispose(reason ?? createRemoteWorkspaceDisconnectedError()),
  });
  // canonical workspace bind 会换代 remote-scoped port。
  // 只有 store 已注册新 services 后才能确认 ready，bind IPC 返回后的调用方才可重新读取并使用新代 services。
  notifyRemoteWorkspaceServicePortReady(params);
}

function flushPendingRemoteWorkspaceServicePorts(): void {
  if (!baseServicesForRemoteSessions || pendingRemoteWorkspaceServicePorts.length === 0) {
    return;
  }

  const pending = pendingRemoteWorkspaceServicePorts.splice(0);
  for (const entry of pending) {
    registerRemoteWorkspaceServicePort(entry);
  }
}

function StartupReadyNotifier() {
  useEffect(() => {
    // T5:React 首次 commit。供启动分阶段耗时计算 react_commit 段。
    (window as Window & { __ZCODE_REACT_COMMIT_AT__?: number }).__ZCODE_REACT_COMMIT_AT__ =
      Date.now();
    // HTML 启动壳的弹出动画结束时，React 首屏可能还没 commit，直接移除壳会露出空白。
    // 这里在 React commit 后通知 index.html，再由启动壳统一判断动画和 React ready 两个条件后退场。
    window.dispatchEvent(new Event("zcode-react-startup-ready"));
  }, []);

  return null;
}

function handleServicePortMessage(event: MessageEvent): void {
  if (event.source === window && event.data?.type === InternalChannels.DatabaseStartupState) {
    const result = databaseStartupStateSchema.safeParse(event.data.state);
    if (!result.success || appInitialized) return;
    const next = result.data;
    if (!databaseStartupAdmission.acceptState(next)) return;
    if (firstStartupStateTimer) clearTimeout(firstStartupStateTimer);
    renderDatabaseStartup();
    enterAppIfPrepared();
    return;
  }

  if (event.data === InternalChannels.TaskNotificationSound) {
    void playTaskNotificationSound();
    return;
  }

  const remoteWorkspacePort = parseRemoteWorkspaceServicePortMessage(event);
  if (remoteWorkspacePort) {
    if (!baseServicesForRemoteSessions) {
      // renderer reload 时 main 可能先补投 remote port，再投本地 ServicePort。
      // 早到的 remote port 不能直接丢弃，否则 SSH host 仍存活但 UI 会进入断连代理。
      pendingRemoteWorkspaceServicePorts.push(remoteWorkspacePort);
      return;
    }

    registerRemoteWorkspaceServicePort(remoteWorkspacePort);
    return;
  }

  if (
    event.source !== window ||
    event.data?.type !== InternalChannels.ServicePort ||
    appInitialized
  )
    return;
  const port = event.ports[0];
  if (!port) return;
  databaseStartupAdmission.acceptPort({ databaseStartupId: event.data.databaseStartupId }, port);
  enterAppIfPrepared();
}

function initializeBusinessRoot(port: MessagePort): void {
  appInitialized = true;
  const services = connectViaMessagePort(port);
  baseServicesForRemoteSessions = services;
  registerBaseWorkspaceServices(services);
  flushPendingRemoteWorkspaceServicePorts();
  const settingService = supportsSettings ? services.settingService : undefined;

  syncAppTelemetryContext({
    bridge: {
      syncTelemetryContext: (context) => window.zcode.syncTelemetryContext(context),
    },
    createRendererContext: collectTelemetryRendererContext,
  });

  // 初始化稳定的设备 ID，确保所有 hook 在首次渲染前就使用正确的值
  setStreamClientId(desktopPlatform.getDeviceId());

  // React 错误边界捕获的异常不会冒泡到 window.onerror，RUM Browser SDK 默认收不到。
  // 必须在 createRoot 之前注入 reporter：根级 AppErrorBoundary 的职责正是兜住 Root 自身
  // 渲染崩溃，若依赖 Root 的 effect 注入，则 Root 首帧就崩时上报会丢失。
  setReactErrorArmsReporter(desktopPlatform);

  appRoot?.render(
    <AppErrorBoundary isDesktop isMacDesktop={isMacDesktop} isWindowsDesktop={isWindowsDesktop}>
      <ZCodeIntlProvider
        settingService={settingService}
        broadcastService={services.broadcastService}
        resolveSystemLocale={desktopPlatform.getSystemLocale}
      >
        <StartupReadyNotifier />
        <Root
          services={services}
          platform={desktopPlatform}
          isDesktop
          assistantCodeCommentCardsEnabled
          isMacDesktop={isMacDesktop}
          isWindowsDesktop={isWindowsDesktop}
          restoreSession={restoreSession}
          supportsSettings={supportsSettings}
          initialWorkspaceAbsPath={initialWorkspaceAbsPath}
          initialWorkspacePurpose={
            initialWorkspacePurpose === "conversation" ? "conversation" : "project"
          }
          unavailableWorkspacePath={unavailableWorkspacePath}
        />
      </ZCodeIntlProvider>
    </AppErrorBoundary>,
  );
}

window.addEventListener("message", handleServicePortMessage);
if (windowKind !== "update-status") {
  renderDatabaseStartup();
  sendStartupControl({ action: "snapshot" });
}

if (windowKind === "update-status") {
  createRoot(document.getElementById("root")!).render(
    <AppErrorBoundary isDesktop isMacDesktop={isMacDesktop} isWindowsDesktop={isWindowsDesktop}>
      <StartupReadyNotifier />
      <UpdateStatusWindowRoot
        platform={desktopPlatform}
        initialLocale={initialLocale}
        onRequestClose={() => window.close()}
      />
    </AppErrorBoundary>,
  );
}
