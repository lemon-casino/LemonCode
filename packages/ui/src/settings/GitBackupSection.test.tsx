import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { GitBackupConfig, GitBackupStatus } from "@lcode/services";
import { LCodeIntlProvider } from "../i18n/IntlProvider.js";
import enUS from "../i18n/locales/en-US.js";
import zhCN from "../i18n/locales/zh-CN.js";
import { GitBackupSettingsView } from "./GitBackupSection.js";
import { createGitBackupDraft } from "../hooks/useGitBackupDraft.js";
import type { useGitBackup } from "../hooks/useGitBackup.js";

const config: GitBackupConfig = {
  enabled: false,
  intervalMinutes: 60,
  oss: {
    accessKeyId: "test-id",
    accessKeySecret: "",
    bucket: "test-backup",
    region: "oss-cn-hangzhou",
  },
  workspaces: [{ workspacePath: "/same/long/path", workspaceIdentity: "remote:example" }],
};
const status: GitBackupStatus = {
  enabled: false,
  configured: true,
  running: false,
  error: null,
  lastBackupAt: null,
  lastBackupFiles: 0,
  lastBackupSize: 0,
  lastWorkspacePath: null,
  nextBackupAt: null,
};
function model(
  overrides: Partial<ReturnType<typeof useGitBackup>> = {},
): ReturnType<typeof useGitBackup> {
  const action = async () => undefined;
  return {
    config,
    status,
    draft: createGitBackupDraft(config),
    provider: "oss",
    selectProvider: () => {},
    setDestinationEnabled: action,
    clearDestination: action,
    canEnableDestination: () => true,
    canBackupAll: true,
    loading: false,
    operation: null,
    error: null,
    notice: null,
    testResult: null,
    publicKey: null,
    legacyDraft: false,
    unavailable: false,
    dirty: false,
    canEnable: true,
    canBackup: true,
    canExport: true,
    refresh: action,
    save: action,
    setEnabled: action,
    testConnection: action,
    backup: action,
    removeWorkspace: action,
    viewPublicKey: action,
    exportPrivateKey: action,
    updateDraft: () => {},
    resetDraft: () => {},
    closePublicKey: () => {},
    ...overrides,
  };
}
function render(overrides: Partial<ReturnType<typeof useGitBackup>> = {}, connected = true) {
  return renderToStaticMarkup(
    <LCodeIntlProvider initialLocale="en-US">
      <GitBackupSettingsView
        backup={model(overrides)}
        target={config.workspaces[0] ?? null}
        connectionKind={connected ? "remote-ready" : "remote-waiting"}
      />
    </LCodeIntlProvider>,
  );
}

test("backup fields have associated accessible labels, saved secret placeholder and responsive layout", () => {
  const markup = render();
  for (const field of ["accessKeyId", "accessKeySecret", "bucket", "region", "pathPrefix"]) {
    const input = markup.match(
      new RegExp(`<input[^>]*data-testid="git-backup-${field}"[^>]*>`),
    )?.[0];
    assert.ok(input);
    const id = input.match(/id="([^"]+)"/)?.[1];
    assert.ok(id);
    assert.ok(markup.includes(`for="${id}"`));
  }
  assert.match(markup, /type="password"/);
  assert.match(markup, /Saved secret; leave blank to keep it/);
  assert.match(markup, /sm:grid-cols-2/);
  assert.match(markup, /No successful backup yet/);
  assert.match(markup, /Uncommitted working files are not backed up/);
  assert.match(markup, /Registered Workspaces/);
  assert.match(markup, /aria-label="Remove \/same\/long\/path from auto backup"/);
});

test("loading, read failure retry, missing Host and remote disconnect are explicit", () => {
  assert.match(
    render({ config: null, draft: null, loading: true }),
    /Loading backup configuration/,
  );
  const failed = render({
    config: null,
    draft: null,
    error: { id: "settings.gitBackup.loadFailed", detail: "Host offline" },
  });
  assert.match(failed, /Host offline/);
  assert.match(failed, /Retry/);
  const disconnected = render({ config: null, draft: null, unavailable: true }, false);
  assert.match(disconnected, /remote workspace is disconnected/);
  assert.doesNotMatch(disconnected, /git-backup-now/);
  assert.match(
    render({ config: null, draft: null, unavailable: true }),
    /Host does not support Git backup/,
  );
});

test("busy switch stays server-backed and actions disable during pending requests", () => {
  const markup = render({ operation: "toggle", config: { ...config, enabled: false } });
  const toggle = markup.match(/<button[^>]*data-testid="git-backup-enabled"[^>]*>/)?.[0];
  assert.ok(toggle);
  assert.match(toggle, /aria-checked="false"/);
  assert.match(toggle, /disabled=""/);
  assert.match(
    markup.match(/<button[^>]*data-testid="git-backup-now"[^>]*>/)?.[0] ?? "",
    /disabled=""/,
  );
});

test("failed connection and backup preserve actual details instead of interpolated placeholders", () => {
  const markup = render({
    testResult: { ok: false, error: "HTTP 403: AccessDenied" },
    error: { id: "settings.gitBackup.backupFailed", detail: "unsupported linked worktree" },
    status: { ...status, error: "network unavailable" },
    dirty: true,
  });
  assert.match(markup, /Connection failed: HTTP 403: AccessDenied/);
  assert.match(markup, /Backup failed: unsupported linked worktree/);
  assert.match(markup, /Last backup error: network unavailable/);
  assert.match(markup, /Unsaved changes/);
  assert.doesNotMatch(markup, /\{error\}/);
});

test("key cancellation and browser initiation have truthful status without private plaintext", () => {
  assert.match(
    render({ notice: { id: "settings.gitBackup.exportCanceled" } }),
    /Private key export canceled/,
  );
  assert.match(
    render({ notice: { id: "settings.gitBackup.downloadStarted" } }),
    /download started/,
  );
  assert.doesNotMatch(render(), /BEGIN PRIVATE KEY/);
});

test("provider tabs isolate switches, fields and actions from shared settings", () => {
  const draft = createGitBackupDraft(config);
  draft.minio.endpoint = "http://storage.example:9000";
  for (const provider of ["oss", "minio"] as const) {
    const markup = render({ provider, draft });
    assert.match(markup, /role="tablist"/);
    assert.match(markup, /data-testid="git-backup-tab-oss"/);
    assert.match(markup, /data-testid="git-backup-tab-minio"/);
    const active = markup.match(
      new RegExp(`<button[^>]*data-testid="git-backup-tab-${provider}"[^>]*>`),
    )?.[0];
    assert.match(active ?? "", /aria-selected="true"/);
    const panel = markup.match(
      new RegExp(`<div[^>]*data-testid="git-backup-panel-${provider}"[^>]*>`),
    )?.[0];
    const controls = active?.match(/aria-controls="([^"]+)"/)?.[1];
    const tabId = active?.match(/\sid="([^"]+)"/)?.[1];
    assert.ok(controls && tabId && panel);
    assert.ok(panel.includes(`id="${controls}"`));
    assert.ok(panel.includes(`aria-labelledby="${tabId}"`));
    const interval = markup.match(/<input[^>]*data-testid="git-backup-interval"[^>]*>/)?.[0];
    const formId = interval?.match(/\sform="([^"]+)"/)?.[1];
    assert.ok(formId);
    assert.ok(markup.includes(`<form id="${formId}"`));
    const other = provider === "oss" ? "minio" : "oss";
    assert.match(markup, new RegExp(`data-testid="git-backup-${provider}-enabled"`));
    assert.doesNotMatch(markup, new RegExp(`data-testid="git-backup-${other}-enabled"`));
    assert.doesNotMatch(markup, /data-testid="git-backup-provider"/);
    assert.equal((markup.match(/data-testid="git-backup-interval"/g) ?? []).length, 1);
    assert.equal((markup.match(/data-testid="git-backup-enabled"/g) ?? []).length, 1);
    assert.equal((markup.match(/data-testid="git-backup-now-all"/g) ?? []).length, 1);
    assert.match(markup, /Shared Backup Settings/);
    assert.match(markup, /Switching tabs does not enable or disable/);
    assert.match(markup, /role="tabpanel"/);
  }
  const minio = render({ provider: "minio", draft });
  assert.match(minio, /git-backup-minio-endpoint/);
  assert.match(minio, /us-east-1/);
  assert.match(minio, /HTTP is not encrypted/);
  assert.match(minio, /Back Up to MinIO/);
  assert.match(minio, /Save MinIO Configuration/);
  assert.match(minio, /Test MinIO Connection/);
  assert.doesNotMatch(minio, /git-backup-region/);
  assert.doesNotMatch(render(), /git-backup-minio-endpoint/);
});

test("both providers remain selected while only the active tab shows its results", () => {
  const saved = {
    ...config,
    minio: { ...config.oss!, endpoint: "https://storage.example:9000", region: "us-east-1" },
    destinationEnabled: { oss: true, minio: true },
  };
  const destination = {
    enabled: true,
    configured: true,
    lastAttemptAt: "2026-09-30T00:00:00Z",
    lastBackupAt: null,
    lastBackupFiles: 0,
    lastBackupSize: 0,
    lastWorkspacePath: null,
    error: null,
  };
  const result = {
    ...status,
    destinations: {
      oss: { ...destination, lastBackupAt: "2026-09-30T00:00:00Z", lastBackupFiles: 3 },
      minio: { ...destination, error: "MinIO HTTP 403" },
    },
  };
  const oss = render({ config: saved, status: result });
  const minio = render({ config: saved, status: result, provider: "minio" });
  assert.match(oss, /git-backup-status-oss/);
  assert.doesNotMatch(oss, /git-backup-status-minio/);
  assert.doesNotMatch(oss, /MinIO HTTP 403/);
  assert.match(oss, /Needs attention/);
  assert.match(minio, /git-backup-status-minio/);
  assert.doesNotMatch(minio, /git-backup-status-oss/);
  assert.match(minio, /MinIO HTTP 403/);
  for (const [markup, provider] of [
    [oss, "oss"],
    [minio, "minio"],
  ] as const) {
    const toggle = markup.match(
      new RegExp(`<button[^>]*data-testid="git-backup-${provider}-enabled"[^>]*>`),
    )?.[0];
    assert.match(toggle ?? "", /aria-checked="true"/);
  }
  assert.deepEqual(saved.destinationEnabled, { oss: true, minio: true });
});

test("tabs remain switchable during connection testing but not accepted write operations", () => {
  for (const operation of ["save", "toggle", "backup", "clear", "test"] as const) {
    const markup = render({ operation });
    for (const provider of ["oss", "minio"]) {
      const tab = markup.match(
        new RegExp(`<button[^>]*data-testid="git-backup-tab-${provider}"[^>]*>`),
      )?.[0];
      assert.ok(tab);
      if (operation === "test") assert.doesNotMatch(tab, /disabled=""/);
      else assert.match(tab, /disabled=""/);
    }
  }
});

test("Git backup locale blocks have matching keys and required failure placeholders", () => {
  const keys = (locale: Record<string, string>) =>
    Object.keys(locale)
      .filter(
        (key) => key.startsWith("settings.gitBackup.") || key.startsWith("gitBackup.welcome."),
      )
      .sort();
  assert.deepEqual(keys(enUS), keys(zhCN));
  for (const locale of [enUS, zhCN]) {
    for (const key of keys(locale).filter(
      (key) => key.endsWith("Failed") && key !== "settings.gitBackup.ossConfig.testSuccess",
    )) {
      assert.match(locale[key] ?? "", /\{error\}/);
    }
  }
});
