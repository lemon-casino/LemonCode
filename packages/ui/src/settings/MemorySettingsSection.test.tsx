import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TID_SETTINGS_MEMORY_SWITCH,
  TID_SETTINGS_SESSION_RECALL_HELP,
  TID_SETTINGS_SESSION_RECALL_SWITCH,
} from "@lcode/shared";
import { LCodeIntlProvider } from "../i18n/IntlProvider.js";
import enUS from "../i18n/locales/en-US.js";
import zhCN from "../i18n/locales/zh-CN.js";
import { MemorySettingsSection } from "./MemorySettingsSection.js";

test("memory settings exposes an independent automatic history recall switch and help trigger", () => {
  const markup = renderToStaticMarkup(
    <LCodeIntlProvider initialLocale="zh-CN">
      <MemorySettingsSection
        memoryEnabled={false}
        memoryService={{ listProjectMemories: async () => [] }}
        memoryStorageLocation="profile"
        onMemoryEnabledChange={async () => undefined}
        onMemoryStorageLocationChange={async (location) => ({
          location,
          copiedCount: 0,
          conflictCount: 0,
        })}
        onSessionRecallEnabledChange={async () => undefined}
        projectMemoryViewerAvailable={false}
        sessionRecallEnabled
      />
    </LCodeIntlProvider>,
  );

  assert.match(markup, /自动历史召回/);
  assert.match(markup, new RegExp(`data-testid="${TID_SETTINGS_MEMORY_SWITCH}"`));
  assert.match(markup, new RegExp(`data-testid="${TID_SETTINGS_SESSION_RECALL_SWITCH}"`));
  assert.match(markup, new RegExp(`data-testid="${TID_SETTINGS_SESSION_RECALL_HELP}"`));
  assert.match(markup, /aria-label="了解自动历史召回"/);
});

test("automatic history recall help explains scope, read-only behavior, and timing", () => {
  const zhHelp = zhCN["settings.memory.sessionRecallHelp"] ?? "";
  const enHelp = enUS["settings.memory.sessionRecallHelp"] ?? "";

  assert.match(zhHelp, /同一工作区/);
  assert.match(zhHelp, /只读/);
  assert.match(zhHelp, /已运行会话/);
  assert.match(enHelp, /same workspace/);
  assert.match(enHelp, /read-only/);
  assert.match(enHelp, /running sessions/);
});

test("local memory storage remains configurable while workspace memory is disabled", () => {
  const markup = renderToStaticMarkup(
    <LCodeIntlProvider initialLocale="zh-CN">
      <MemorySettingsSection
        memoryEnabled={false}
        memoryService={{ listProjectMemories: async () => [] }}
        memoryStorageLocation="profile"
        onMemoryEnabledChange={async () => undefined}
        onMemoryStorageLocationChange={async (location) => ({
          location,
          copiedCount: 0,
          conflictCount: 0,
        })}
        onSessionRecallEnabledChange={async () => undefined}
        projectMemoryViewerAvailable
        sessionRecallEnabled={false}
      />
    </LCodeIntlProvider>,
  );
  assert.match(markup, /data-testid="settings-memory-storage-location"/);
  assert.match(markup, /本机资料目录/);
  assert.match(markup, /保留原文件/);
  assert.match(markup, /多文件夹项目以主文件夹为准/);
  assert.doesNotMatch(markup, /data-testid="settings-memory-storage-location"[^>]*disabled/);
});
