/* eslint-disable max-lines -- 桌面命令分发需要共享窗口与平台上下文，集中维护更便于一致性 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow, dialog, session, shell } from "electron";
import type { MessageBoxOptions } from "electron";
import {
  DEFAULT_LCODE_ENDPOINT_ORIGIN,
  DesktopCommandIds,
  PlatformChannels,
  type AppSettings,
  type DesktopCommandId,
  type Locale,
  resolveRuntimeLCodeEndpointOrigin,
  LCODE_ENV,
  LCODE_PRODUCT_FLAVOR,
  buildLCodeEndpointUrls,
  getCommunityUrlFromConfigs,
  getFeedbackUrlFromConfig,
  resolveHelpAppConfig,
  normalizeLCodeEndpointOrigin,
  resolveLCodeEndpointOrigin,
} from "@lcode/shared";
import { readLCodeStdioTapDevState, setLCodeStdioTapDevEnabled } from "@lcode/services/node";
import { showAboutDialog } from "./about.js";
import { checkForUpdateMenuClick } from "./autoUpdater.js";
import { exportLogs } from "./exportLogs.js";
import { openResourceManager } from "./resourceManagerWindow.js";
import { resolveCuaOsSupport } from "./cuaOsSupport.js";
import { syncWindowControlsOverlayForZoomLevel } from "./desktopWindowButtonPosition.js";
import {
  DEFAULT_DESKTOP_WINDOW_HEIGHT,
  DEFAULT_DESKTOP_WINDOW_WIDTH,
} from "./desktopWindowSize.js";
import {
  clampDesktopZoomLevel,
  resolveDesktopZoomFactorForLevel,
  resolveDesktopZoomLevelFromFactor,
} from "./desktopZoom.js";

export const HELP_TOGGLE_DEV_TOOLS_MENU_ID = "help.toggle-dev-tools";
export const HELP_TOGGLE_LCODE_STDIO_TAP_MENU_ID = "help.toggle-lcode-stdio-tap";
const LCODE_ENDPOINT_PROMPT_WIDTH = 460;
const LCODE_ENDPOINT_PROMPT_HEIGHT = 210;
const CODING_PLAN_WEBVIEW_PARTITION = "persist:lcode-coding-plan";

function resolveTargetWindow(senderWindow?: BrowserWindow | null) {
  if (senderWindow && !senderWindow.isDestroyed()) {
    return senderWindow;
  }

  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
}
function updateDesktopZoomLevel(
  targetWindow: BrowserWindow | null | undefined,
  action: "reset" | "in" | "out",
) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  const currentLevel = resolveDesktopZoomLevelFromFactor(targetWindow.webContents.getZoomFactor());
  const nextLevel =
    action === "reset" ? 0 : clampDesktopZoomLevel(currentLevel + (action === "in" ? 1 : -1));

  // 系统缩放快捷键需要可用，但不能无限放大/缩小导致界面失控。
  // Electron zoomLevel 的真实比例是 1.2^level；这里改用 zoomFactor，保证每档统一为 1.1。
  targetWindow.webContents.setZoomFactor(resolveDesktopZoomFactorForLevel(nextLevel));
  syncWindowControlsOverlayForZoomLevel(targetWindow, nextLevel);
  targetWindow.webContents.send(PlatformChannels.DesktopZoomLevelChanged, { zoomLevel: nextLevel });
  return nextLevel;
}

function showMessageBoxWithOptionalParent(
  parentWindow: BrowserWindow | null | undefined,
  options: MessageBoxOptions,
) {
  return parentWindow
    ? dialog.showMessageBox(parentWindow, options)
    : dialog.showMessageBox(options);
}
async function clearAllDataAndRelaunch(options: {
  credentialsDir: string;
  logger: {
    info: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}) {
  const { response } = await dialog.showMessageBox({
    type: "warning",
    buttons: ["Cancel", "Clear All"],
    defaultId: 0,
    cancelId: 0,
    title: "Clear All Data",
    message: "确定要清除所有数据吗？",
    detail:
      "将删除 ~/.lcode/v2（配置、凭据、日志）和浏览器缓存（localStorage）。操作不可恢复，清除后应用将自动重启。",
  });
  if (response !== 1) {
    return;
  }

  const { rm } = await import("node:fs/promises");
  try {
    await rm(options.credentialsDir, { recursive: true, force: true });
    options.logger.info("[clear-all-data] deleted ~/.lcode/v2");
  } catch (error) {
    options.logger.error("[clear-all-data] failed to delete ~/.lcode/v2:", error);
  }

  for (const win of BrowserWindow.getAllWindows()) {
    try {
      await win.webContents.executeJavaScript("localStorage.clear()");
    } catch {
      // 窗口可能已经销毁，忽略
    }
  }

  try {
    const session = BrowserWindow.getAllWindows()[0]?.webContents.session;
    if (session) {
      await session.clearStorageData();
      options.logger.info("[clear-all-data] cleared session storage data");
    }
  } catch (error) {
    options.logger.error("[clear-all-data] failed to clear session data:", error);
  }

  app.relaunch();
  app.exit(0);
}

export async function clearCodingPlanWebviewStorage(options: {
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
}) {
  try {
    // Coding Plan webview 使用独立持久 partition，默认窗口 session.clearStorageData()
    // 不会覆盖它；退出登录/清理数据时必须显式清除，避免旧账号 token 被下一次官网首屏读到。
    await session.fromPartition(CODING_PLAN_WEBVIEW_PARTITION).clearStorageData();
    options.logger.info("[coding-plan-webview] cleared persistent partition storage");
  } catch (error) {
    options.logger.warn(
      "[coding-plan-webview] failed to clear persistent partition storage:",
      error,
    );
  }
}

async function fetchRemoteAppConfig(fetchRemoteConfig?: () => Promise<unknown>): Promise<unknown> {
  if (!fetchRemoteConfig) throw new Error("Help config reader is unavailable");
  return fetchRemoteConfig();
}

function resolveLocalAppConfigPath(options?: {
  appPath?: string;
  isPackaged?: boolean;
  resourcesPath?: string;
}): string {
  const isPackaged = options?.isPackaged ?? app.isPackaged;
  if (isPackaged) {
    // app.getAppPath() 在正式包中指向 resources/app.asar，向上两级后会误读
    // Contents/config。内置配置由 electron-builder 放在 resources/config，必须从 resourcesPath 解析。
    return join(options?.resourcesPath ?? process.resourcesPath, "config/default.json");
  }
  return join(options?.appPath ?? app.getAppPath(), "../../config/default.json");
}

async function readLocalAppConfig(readLocalConfig?: () => unknown): Promise<unknown> {
  const localConfigPath = resolveLocalAppConfigPath();
  return readLocalConfig?.() ?? JSON.parse(await readFile(localConfigPath, "utf-8"));
}

async function resolveRemoteAppConfigValue(options: {
  fetchRemoteConfig?: () => Promise<unknown>;
  readLocalConfig?: () => unknown;
  resolveFromConfig: (config: unknown) => string | undefined;
  logPrefix: "feedback" | "community";
  logger: {
    warn: (...args: unknown[]) => void;
  };
}): Promise<string | undefined> {
  try {
    const remoteConfig = await fetchRemoteAppConfig(options.fetchRemoteConfig);
    const remoteResolvedValue = options.resolveFromConfig(remoteConfig);
    if (remoteResolvedValue) {
      return remoteResolvedValue;
    }
  } catch (error) {
    options.logger.warn(`[${options.logPrefix}] failed to fetch remote config:`, error);
  }

  try {
    const localConfig = await readLocalAppConfig(options.readLocalConfig);
    const localResolvedValue = options.resolveFromConfig(localConfig);
    if (localResolvedValue) {
      return localResolvedValue;
    }
  } catch (error) {
    options.logger.warn(`[${options.logPrefix}] failed to read local config:`, error);
  }

  return undefined;
}

export async function resolveFeedbackUrl(options: {
  fetchRemoteConfig?: () => Promise<unknown>;
  readLocalConfig?: () => unknown;
  logger: {
    warn: (...args: unknown[]) => void;
  };
}): Promise<string | undefined> {
  return resolveRemoteAppConfigValue({
    ...options,
    logPrefix: "feedback",
    resolveFromConfig: getFeedbackUrlFromConfig,
  });
}

export async function resolveCommunityUrl(options: {
  locale: Locale;
  fetchRemoteConfig?: () => Promise<unknown>;
  readLocalConfig?: () => unknown;
  logger: {
    warn: (...args: unknown[]) => void;
  };
}): Promise<string | undefined> {
  let remoteConfig: unknown;
  try {
    remoteConfig = await fetchRemoteAppConfig(options.fetchRemoteConfig);
  } catch (error) {
    options.logger.warn("[community] failed to fetch remote config:", error);
  }

  let localConfig: unknown;
  try {
    localConfig = await readLocalAppConfig(options.readLocalConfig);
  } catch (error) {
    options.logger.warn("[community] failed to read local config:", error);
  }

  return getCommunityUrlFromConfigs(remoteConfig, localConfig, options.locale);
}

async function openFeedback(
  logger: { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void },
  targetWindow?: BrowserWindow | null,
  fetchRemoteConfig?: () => Promise<unknown>,
) {
  let remoteConfig: unknown;
  let localConfig: unknown;
  try {
    remoteConfig = await fetchRemoteAppConfig(fetchRemoteConfig);
  } catch (error) {
    logger.warn("[feedback] failed to fetch remote config:", error);
  }
  try {
    localConfig = await readLocalAppConfig();
  } catch (error) {
    logger.warn("[feedback] failed to read local config:", error);
  }
  const config = resolveHelpAppConfig(remoteConfig, localConfig);
  if (!config.feedback_use_external_form) {
    resolveTargetWindow(targetWindow)?.webContents.send(PlatformChannels.OpenFeedbackDialog);
    return;
  }
  if (config.feedback_url) await shell.openExternal(config.feedback_url);
}

async function openCommunity(
  locale: Locale,
  logger: {
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  },
  fetchRemoteConfig?: () => Promise<unknown>,
) {
  const communityUrl = await resolveCommunityUrl({ locale, logger, fetchRemoteConfig });
  if (!communityUrl) {
    logger.warn("[community] community_urls is missing from both remote and local config");
    return;
  }
  await shell.openExternal(communityUrl);
}

async function promptCustomLCodeEndpoint(
  targetWindow: BrowserWindow | null | undefined,
  currentValue: string,
): Promise<string | undefined> {
  return showLCodeEndpointPromptWindow({
    currentValue,
    parentWindow: targetWindow && !targetWindow.isDestroyed() ? targetWindow : undefined,
  });
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildLCodeEndpointPromptHtml(currentValue: string): string {
  const value = escapeHtmlAttribute(currentValue);
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>LCode Endpoint</title>
    <style>
      :root { color-scheme: light dark; }
      body { margin: 0; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      label { display: block; margin-bottom: 8px; font-size: 13px; font-weight: 600; }
      input { box-sizing: border-box; width: 100%; height: 34px; padding: 6px 8px; font: inherit; }
      .hint { margin-top: 8px; color: #6b7280; font-size: 12px; }
      .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
      button { min-width: 78px; height: 30px; font: inherit; }
    </style>
  </head>
  <body>
    <form id="form">
      <label for="endpoint">LCode endpoint origin</label>
      <input id="endpoint" value="${value}" placeholder="https://endpoint.example.com" spellcheck="false" />
      <div class="hint">Use an http or https origin, for example https://endpoint.example.com.</div>
      <div class="actions">
        <button id="cancel" type="button">Cancel</button>
        <button type="submit">Save</button>
      </div>
    </form>
    <script>
      const input = document.getElementById("endpoint");
      const submit = (value) => { document.title = "lcode-endpoint-submit:" + encodeURIComponent(value); };
      document.getElementById("form").addEventListener("submit", (event) => {
        event.preventDefault();
        submit(input.value);
      });
      document.getElementById("cancel").addEventListener("click", () => {
        document.title = "lcode-endpoint-cancel";
      });
      input.focus();
      input.select();
    </script>
  </body>
</html>`;
}

function showLCodeEndpointPromptWindow(options: {
  currentValue: string;
  parentWindow?: BrowserWindow;
}): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const promptWindow = new BrowserWindow({
      width: LCODE_ENDPOINT_PROMPT_WIDTH,
      height: LCODE_ENDPOINT_PROMPT_HEIGHT,
      parent: options.parentWindow,
      modal: Boolean(options.parentWindow),
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: "LCode Endpoint",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    const finish = (value: string | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
      if (!promptWindow.isDestroyed()) {
        promptWindow.close();
      }
    };

    promptWindow.on("closed", () => finish(undefined));
    promptWindow.on("page-title-updated", (event, title) => {
      if (title === "lcode-endpoint-cancel") {
        event.preventDefault();
        finish(undefined);
        return;
      }
      if (!title.startsWith("lcode-endpoint-submit:")) {
        return;
      }
      event.preventDefault();
      finish(decodeURIComponent(title.slice("lcode-endpoint-submit:".length)));
    });

    // Electron 菜单命令在主进程触发，调用 renderer 的 window.prompt 可能被禁用或没有焦点，表现为点击无反应。
    // 这里改为主进程创建受控 modal 输入窗，确保 Custom... 始终有可见交互入口。
    void promptWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(
        buildLCodeEndpointPromptHtml(options.currentValue),
      )}`,
    );
  });
}

async function setLCodeEndpointOverride(options: {
  value: string | undefined;
  settingService: { update(patch: { lcodeEndpointOrigin?: string | undefined }): Promise<void> };
  onLCodeEndpointChanged: () => Promise<void> | void;
  logger: { warn: (...args: unknown[]) => void };
}) {
  if (LCODE_ENV === "production") {
    return;
  }
  const normalized = options.value ? normalizeLCodeEndpointOrigin(options.value) : undefined;
  await options.settingService.update({ lcodeEndpointOrigin: normalized });
  await options.onLCodeEndpointChanged();
}

async function persistDesktopZoomLevel(options: {
  zoomLevel: number;
  logger: { warn: (...args: unknown[]) => void };
  settingService: { update(patch: Pick<AppSettings, "desktopZoomLevel">): Promise<void> };
}) {
  try {
    // 桌面缩放命令原本只改当前 BrowserWindow，重启后没有任何恢复来源。
    // 这里在命令成功后把夹取后的档位写入 setting.json，让快捷键、View 菜单和侧边栏菜单共享同一持久化事实源。
    await options.settingService.update({ desktopZoomLevel: options.zoomLevel });
  } catch (error) {
    options.logger.warn("[desktop-zoom] persist zoom level failed:", error);
  }
}

function toggleLCodeStdioTapDevProxy(options: {
  logger: { info: (...args: unknown[]) => void };
  updateLCodeStdioTapDevMenuState: () => void;
}) {
  const current = readLCodeStdioTapDevState();
  const next = setLCodeStdioTapDevEnabled(!current.enabled);
  options.updateLCodeStdioTapDevMenuState();
  options.logger.info("[stdio-tap] dev proxy toggled", {
    enabled: next.enabled,
    visible: next.visible,
    logDir: next.logDir,
  });
}

function resolveChangelogUrl(
  locale: Locale,
  endpointOrigin = DEFAULT_LCODE_ENDPOINT_ORIGIN,
): string {
  // 帮助菜单里的外链以前只有固定英文地址，切到中文界面后仍会落到英文 changelog。
  // 这里统一收口到主进程按当前应用语言分流，避免菜单模板里手写分支后续再出现多处不一致。
  const origin = buildLCodeEndpointUrls(endpointOrigin).origin;
  return locale === "zh-CN" ? `${origin}/cn/changelog` : `${origin}/en/changelog`;
}

export async function openChangelog(
  locale: Locale,
  endpointOrigin = DEFAULT_LCODE_ENDPOINT_ORIGIN,
) {
  await shell.openExternal(resolveChangelogUrl(locale, endpointOrigin));
}

async function resolveCurrentLCodeEndpointOrigin(settingService: {
  get(): Promise<{ lcodeEndpointOrigin?: string }>;
  envBaseOrigin?: string | null;
}): Promise<string> {
  const settings = await settingService.get();
  return resolveLCodeEndpointOrigin({
    env: LCODE_ENV,
    envBaseOrigin: settingService.envBaseOrigin,
    overrideOrigin: settings.lcodeEndpointOrigin,
  });
}

export async function executeDesktopCommand(options: {
  command: DesktopCommandId;
  fetchHelpConfig?: () => Promise<unknown>;
  senderWindow?: BrowserWindow | null;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  updateLCodeStdioTapDevMenuState: () => void;
  onDesktopZoomChanged?: (zoomLevel: number) => Promise<void> | void;
  onLCodeEndpointChanged: () => Promise<void> | void;
  onRelaunchApp: () => Promise<void>;
  settingService: {
    get(): Promise<Pick<AppSettings, "lcodeEndpointOrigin" | "desktopZoomLevel">>;
    update(
      patch: Partial<Pick<AppSettings, "lcodeEndpointOrigin" | "desktopZoomLevel">>,
    ): Promise<void>;
  };
  lcodeEndpointEnvBaseOrigin?: string | null;
  credentialsDir: string;
  currentApplicationLocale: Locale;
}) {
  const targetWindow = resolveTargetWindow(options.senderWindow);
  options.logger.info(
    `[desktop-command] execute ${options.command} windowId=${targetWindow?.id ?? "<none>"}`,
  );

  switch (options.command) {
    case DesktopCommandIds.NewTask:
      targetWindow?.webContents.send(PlatformChannels.NewTask);
      return;
    case DesktopCommandIds.OpenWorkspace:
      targetWindow?.webContents.send(PlatformChannels.OpenWorkspace);
      return;
    case DesktopCommandIds.CloseActiveContext:
      targetWindow?.webContents.send(PlatformChannels.CloseActiveContextRequest);
      return;
    case DesktopCommandIds.CloseWindow:
      targetWindow?.close();
      return;
    case DesktopCommandIds.MinimizeWindow:
      targetWindow?.minimize();
      return;
    case DesktopCommandIds.ToggleMaximizeWindow:
      if (targetWindow?.isMaximized()) {
        targetWindow.unmaximize();
      } else {
        targetWindow?.maximize();
      }
      return;
    case DesktopCommandIds.ToggleFullScreen:
      if (targetWindow) {
        targetWindow.setFullScreen(!targetWindow.isFullScreen());
      }
      return;
    case DesktopCommandIds.ResetWindowSize:
      if (targetWindow) {
        if (targetWindow.isFullScreen()) targetWindow.setFullScreen(false);
        if (targetWindow.isMaximized()) targetWindow.unmaximize();
        targetWindow.setSize(DEFAULT_DESKTOP_WINDOW_WIDTH, DEFAULT_DESKTOP_WINDOW_HEIGHT, true);
      }
      return;
    case DesktopCommandIds.ResetZoom:
      {
        const nextZoomLevel = updateDesktopZoomLevel(targetWindow, "reset");
        if (nextZoomLevel !== undefined) {
          await persistDesktopZoomLevel({
            zoomLevel: nextZoomLevel,
            logger: options.logger,
            settingService: options.settingService,
          });
          await options.onDesktopZoomChanged?.(nextZoomLevel);
        }
      }
      return;
    case DesktopCommandIds.ZoomIn:
      {
        const nextZoomLevel = updateDesktopZoomLevel(targetWindow, "in");
        if (nextZoomLevel !== undefined) {
          await persistDesktopZoomLevel({
            zoomLevel: nextZoomLevel,
            logger: options.logger,
            settingService: options.settingService,
          });
          await options.onDesktopZoomChanged?.(nextZoomLevel);
        }
      }
      return;
    case DesktopCommandIds.ZoomOut:
      {
        const nextZoomLevel = updateDesktopZoomLevel(targetWindow, "out");
        if (nextZoomLevel !== undefined) {
          await persistDesktopZoomLevel({
            zoomLevel: nextZoomLevel,
            logger: options.logger,
            settingService: options.settingService,
          });
          await options.onDesktopZoomChanged?.(nextZoomLevel);
        }
      }
      return;
    case DesktopCommandIds.ShowAbout:
      await showAboutDialog(targetWindow ?? undefined, options.currentApplicationLocale);
      return;
    case DesktopCommandIds.OpenChangelog:
      await openChangelog(
        options.currentApplicationLocale,
        await resolveCurrentLCodeEndpointOrigin({
          ...options.settingService,
          envBaseOrigin: options.lcodeEndpointEnvBaseOrigin,
        }),
      );
      return;
    case DesktopCommandIds.CheckForUpdates:
      // 按产品身份而不是后端环境放行：生产后端的 Preview 同样没有更新器。
      if (LCODE_PRODUCT_FLAVOR === "production") {
        checkForUpdateMenuClick(targetWindow);
      } else {
        options.logger.info("[auto-update] Preview 已禁用手动更新检查");
      }
      return;
    case DesktopCommandIds.RelaunchApp:
      await options.onRelaunchApp();
      return;
    case DesktopCommandIds.OpenFeedback:
      await openFeedback(options.logger, targetWindow, options.fetchHelpConfig);
      return;
    case DesktopCommandIds.OpenCommunity:
      await openCommunity(
        options.currentApplicationLocale,
        options.logger,
        options.fetchHelpConfig,
      );
      return;
    case DesktopCommandIds.ExportLogs:
      await exportLogs();
      return;
    case DesktopCommandIds.ToggleDevTools:
      targetWindow?.webContents.toggleDevTools();
      return;
    case DesktopCommandIds.OpenResourceManager:
      openResourceManager();
      return;
    case DesktopCommandIds.ToggleLCodeStdioTapDevProxy:
      toggleLCodeStdioTapDevProxy({
        logger: options.logger,
        updateLCodeStdioTapDevMenuState: options.updateLCodeStdioTapDevMenuState,
      });
      return;
    case DesktopCommandIds.SetLCodeEndpointProduction:
      await setLCodeEndpointOverride({
        value: DEFAULT_LCODE_ENDPOINT_ORIGIN,
        settingService: options.settingService,
        onLCodeEndpointChanged: options.onLCodeEndpointChanged,
        logger: options.logger,
      });
      return;
    case DesktopCommandIds.SetLCodeEndpointTest:
      await setLCodeEndpointOverride({
        value: options.lcodeEndpointEnvBaseOrigin ?? resolveRuntimeLCodeEndpointOrigin(),
        settingService: options.settingService,
        onLCodeEndpointChanged: options.onLCodeEndpointChanged,
        logger: options.logger,
      });
      return;
    case DesktopCommandIds.SetLCodeEndpointCustom: {
      const current =
        (await options.settingService.get()).lcodeEndpointOrigin ?? DEFAULT_LCODE_ENDPOINT_ORIGIN;
      const value = await promptCustomLCodeEndpoint(targetWindow, current);
      if (!value) {
        return;
      }
      try {
        await setLCodeEndpointOverride({
          value,
          settingService: options.settingService,
          onLCodeEndpointChanged: options.onLCodeEndpointChanged,
          logger: options.logger,
        });
      } catch (error) {
        await showMessageBoxWithOptionalParent(targetWindow, {
          type: "error",
          title: "LCode Endpoint",
          message: "Endpoint 无效",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    case DesktopCommandIds.ResetLCodeEndpoint:
      await setLCodeEndpointOverride({
        value: undefined,
        settingService: options.settingService,
        onLCodeEndpointChanged: options.onLCodeEndpointChanged,
        logger: options.logger,
      });
      return;
    case DesktopCommandIds.ClearAllData:
      await clearCodingPlanWebviewStorage({ logger: options.logger });
      await clearAllDataAndRelaunch({
        credentialsDir: options.credentialsDir,
        logger: options.logger,
      });
      return;
    case DesktopCommandIds.ClearCodingPlanWebviewStorage:
      await clearCodingPlanWebviewStorage({ logger: options.logger });
      return;
    case DesktopCommandIds.GetCuaOsSupport:
      return resolveCuaOsSupport();
  }
}
