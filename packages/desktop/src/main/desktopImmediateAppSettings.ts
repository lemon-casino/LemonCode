import {
  appSettingsPatchSchema,
  formatZodError,
  PlatformChannels,
  type AppSettings,
} from "@lcode/shared";

export type ImmediateAppSettingsPatch = Pick<
  Partial<AppSettings>,
  | "closeToTrayOnWindows"
  | "keepAwakeWhileRunning"
  | "receivePreviewUpdates"
  | "shortcutBindings"
  | "autoDownloadAndInstallUpdates"
  | "memoryStorageLocation"
  | "memoryStorageRevision"
>;
interface SettingsNotificationWindow {
  isDestroyed(): boolean;
  webContents: { send(channel: string): void };
}

/** Main 只装配即时原生操作与读取失效通知，不持有记忆位置事实。 */
export function applyDesktopImmediateAppSettings(
  patch: ImmediateAppSettingsPatch,
  options: {
    syncCloseToTrayOnWindows: (value: unknown) => void;
    setKeepAwakeWhileRunning: (value: boolean) => void;
    refreshPreviewUpdates: (value: boolean) => void;
    rebuildMenu: () => void;
    getApplicationWindows: () => readonly SettingsNotificationWindow[];
  },
) {
  options.syncCloseToTrayOnWindows(patch.closeToTrayOnWindows);
  if (typeof patch.keepAwakeWhileRunning === "boolean")
    options.setKeepAwakeWhileRunning(patch.keepAwakeWhileRunning);
  if (typeof patch.receivePreviewUpdates === "boolean")
    options.refreshPreviewUpdates(patch.receivePreviewUpdates);
  if (patch.shortcutBindings !== undefined) {
    options.rebuildMenu();
  }
  // 记忆位置已由 SettingService 提交；原入口只在 shortcut 改动时通知，其他窗口会卡在旧值。
  // Main 仅使各窗口的读取失效，不缓存、应用位置或把接收到的 patch 当持久化事实。
  if (
    patch.shortcutBindings !== undefined ||
    patch.memoryStorageLocation !== undefined ||
    patch.memoryStorageRevision !== undefined
  ) {
    for (const win of options.getApplicationWindows()) {
      if (!win.isDestroyed()) win.webContents.send(PlatformChannels.SettingsChanged);
    }
  }
}

/** 使用既有原生 IPC 通道，严格校验后交给同一即时处理入口。 */
export function registerDesktopAppSettingsSyncIpcHandler(options: {
  ipcMain: {
    on(
      channel: typeof PlatformChannels.SyncAppSettings,
      handler: (event: unknown, payload: unknown) => void,
    ): unknown;
  };
  syncAppSettings: (patch: ReturnType<typeof appSettingsPatchSchema.parse>) => void;
  warn: (...args: unknown[]) => void;
}) {
  options.ipcMain.on(PlatformChannels.SyncAppSettings, (_event, payload) => {
    const result = appSettingsPatchSchema.safeParse(payload);
    if (!result.success) {
      options.warn("[settings] invalid app settings sync payload:", formatZodError(result.error));
      return;
    }
    options.syncAppSettings(result.data);
  });
}
