import assert from "node:assert/strict";
import test from "node:test";
import { PlatformChannels } from "@lcode/shared";
import {
  applyDesktopImmediateAppSettings,
  registerDesktopAppSettingsSyncIpcHandler,
} from "./desktopImmediateAppSettings.js";

function fixture() {
  const notifications: string[][] = [[], [], []];
  const native: unknown[][] = [];
  const warnings: unknown[][] = [];
  const handlers = new Map<string, (event: unknown, payload: unknown) => void>();
  const options = {
    syncCloseToTrayOnWindows: (value: unknown) => {
      if (typeof value === "boolean") native.push(["tray", value]);
    },
    setKeepAwakeWhileRunning: (value: boolean) => {
      native.push(["awake", value]);
    },
    refreshPreviewUpdates: (value: boolean) => {
      native.push(["preview", value]);
    },
    rebuildMenu: () => {
      native.push(["menu"]);
    },
    getApplicationWindows: () =>
      notifications.map((values, index) => ({
        isDestroyed: () => index === 2,
        webContents: {
          send: (channel: string) => {
            values.push(channel);
          },
        },
      })),
  };
  registerDesktopAppSettingsSyncIpcHandler({
    ipcMain: {
      on: (channel, handler) => {
        handlers.set(channel, handler);
      },
    },
    syncAppSettings: (patch) => applyDesktopImmediateAppSettings(patch, options),
    warn: (...args) => {
      warnings.push(args);
    },
  });
  return {
    notifications,
    native,
    warnings,
    send: (payload: unknown) =>
      handlers.get(PlatformChannels.SyncAppSettings)!({ sender: { id: 1 } }, payload),
  };
}

test("validated memory location and revision notifications reach all live windows", () => {
  const h = fixture();
  h.send({ memoryStorageLocation: "workspace" });
  assert.deepEqual(h.notifications, [
    [PlatformChannels.SettingsChanged],
    [PlatformChannels.SettingsChanged],
    [],
  ]);
  h.send({ memoryStorageRevision: 0 });
  h.send({ memoryStorageLocation: "profile", memoryStorageRevision: 2 });
  assert.deepEqual(
    h.notifications.map((values) => values.length),
    [3, 3, 0],
  );
  // Main 仅发送失效通知，没有持久化位置的状态或把新值作为窗口事实推送。
  assert.deepEqual(h.native, []);
  assert.deepEqual(h.warnings, []);
});

test("shortcut and memory patch sends one invalidation while retaining native effects", () => {
  const h = fixture();
  h.send({
    shortcutBindings: {},
    memoryStorageLocation: "workspace",
    memoryStorageRevision: 1,
    closeToTrayOnWindows: false,
    keepAwakeWhileRunning: true,
    receivePreviewUpdates: true,
  });
  assert.deepEqual(h.native, [["tray", false], ["awake", true], ["preview", true], ["menu"]]);
  assert.deepEqual(
    h.notifications.map((values) => values.length),
    [1, 1, 0],
  );
});

test("unrelated native settings retain their original routing without invalidating memory", () => {
  const h = fixture();
  h.send({
    closeToTrayOnWindows: true,
    keepAwakeWhileRunning: false,
    receivePreviewUpdates: false,
  });
  h.send({});
  assert.deepEqual(h.native, [
    ["tray", true],
    ["awake", false],
    ["preview", false],
  ]);
  assert.deepEqual(h.notifications, [[], [], []]);
});

test("invalid location or revision is rejected by the production IPC schema before notification", () => {
  const h = fixture();
  h.send({ memoryStorageLocation: "other" });
  h.send({ memoryStorageRevision: -1 });
  h.send({ memoryStorageRevision: Number.MAX_SAFE_INTEGER + 1 });
  assert.equal(h.warnings.length, 3);
  assert.deepEqual(h.notifications, [[], [], []]);
  assert.deepEqual(h.native, []);
});
