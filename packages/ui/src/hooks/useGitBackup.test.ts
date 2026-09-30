import assert from "node:assert/strict";
import test from "node:test";
import type {
  GitBackupConfig,
  GitBackupOssConfig,
  GitBackupStatus,
  IGitBackupService,
} from "@lcode/services";
import type { IPlatformService } from "@lcode/shared";
import {
  createGitBackupDraft,
  hasStoredGitBackupSecret,
  isGitBackupDraftDirty,
  validateGitBackupDraft,
  validateGitBackupOss,
  validateGitBackupMinio,
  createGitBackupSavePatch,
  acceptGitBackupDraftSave,
} from "./useGitBackupDraft.js";
import {
  canUseSavedGitBackupConfig,
  createGitBackupRequestScope,
  exportGitBackupPrivateKey,
  loadGitBackupSnapshot,
  projectGitBackupEnabledStatus,
  projectGitBackupDestinationSelection,
  projectGitBackupDestinationClear,
  projectGitBackupConfigStatus,
  canUseSelectedGitBackupProviders,
  projectGitBackupWorkspaceRemoval,
  runGitBackup,
} from "./useGitBackupActions.js";

import { resolveGitBackupConnectionKind } from "./useGitBackupRouting.js";

const oss: GitBackupOssConfig = {
  accessKeyId: "LTAITest",
  accessKeySecret: "test-secret",
  bucket: "test-backup",
  region: "cn-hangzhou",
  pathPrefix: "backups/git",
};
const config: GitBackupConfig = { enabled: false, intervalMinutes: 60, oss, workspaces: [] };
const status: GitBackupStatus = {
  enabled: true,
  configured: true,
  lastBackupAt: "2026-09-01T00:00:00.000Z",
  lastBackupFiles: 3,
  lastBackupSize: 4096,
  lastWorkspacePath: "/same/path",
  nextBackupAt: "2026-09-01T01:00:00.000Z",
  running: true,
  error: "previous backup failed",
};

test("accepted last-workspace removal projects disabled config and status before any readback", () => {
  const target = { workspacePath: "/same/path", workspaceIdentity: "remote:one" };
  const saved = { ...config, enabled: true, workspaces: [target] };
  const projected = projectGitBackupWorkspaceRemoval(saved, status, {
    ...target,
    workspaceIdentity: " remote:one ",
  });
  assert.deepEqual(projected.config, { ...saved, enabled: false, workspaces: [] });
  assert.deepEqual(projected.status, { ...status, enabled: false, nextBackupAt: null });
  assert.deepEqual(saved.workspaces, [target]);
  assert.equal(saved.enabled, true);
  assert.equal(status.enabled, true);
  assert.equal(status.nextBackupAt, "2026-09-01T01:00:00.000Z");
  assert.equal(projectGitBackupWorkspaceRemoval(saved, null, target).status, null);
});

test("failed readback preserves accepted removal without hiding the load failure", async () => {
  const target = { workspacePath: "/repo" };
  let acceptedConfig = { ...config, enabled: true, workspaces: [target] };
  let acceptedStatus = status;
  const service = {
    removeWorkspace: async () => {
      acceptedConfig = { ...acceptedConfig, enabled: false, workspaces: [] };
      acceptedStatus = { ...acceptedStatus, enabled: false, nextBackupAt: null };
    },
    getConfig: async () => acceptedConfig,
    getStatus: async () => {
      throw new Error("status read unavailable");
    },
  } as unknown as IGitBackupService;
  let projection = { config: acceptedConfig, status: acceptedStatus as GitBackupStatus | null };
  await service.removeWorkspace(target);
  projection = projectGitBackupWorkspaceRemoval(projection.config, projection.status, target);
  await assert.rejects(loadGitBackupSnapshot(service), /status read unavailable/);
  assert.deepEqual(projection.config, acceptedConfig);
  assert.deepEqual(projection.status, acceptedStatus);
});

test("removal preserves other identities and the observed schedule while targets remain", () => {
  const local = { workspacePath: "/same/path" };
  const remote = { workspacePath: "/same/path", workspaceIdentity: "remote:one" };
  const saved = { ...config, enabled: true, workspaces: [local, remote] };
  const projected = projectGitBackupWorkspaceRemoval(saved, status, remote);
  assert.deepEqual(projected.config, { ...saved, workspaces: [local] });
  assert.deepEqual(projected.status, status);
  assert.deepEqual(saved.workspaces, [local, remote]);
  const disabled = projectGitBackupWorkspaceRemoval(
    { ...saved, enabled: false },
    { ...status, enabled: false, nextBackupAt: null },
    local,
  );
  assert.equal(disabled.config.enabled, false);
  assert.deepEqual(disabled.config.workspaces, [remote]);
  assert.equal(disabled.status?.nextBackupAt, null);
});

test("accepted enabled projection does not invent credential readiness or a new due time", () => {
  assert.deepEqual(projectGitBackupEnabledStatus(status, false), {
    ...status,
    enabled: false,
    nextBackupAt: null,
  });
  const unconfigured = { ...status, enabled: false, configured: false, nextBackupAt: null };
  assert.deepEqual(projectGitBackupEnabledStatus(unconfigured, true), {
    ...unconfigured,
    enabled: true,
  });
  assert.deepEqual(projectGitBackupEnabledStatus(status, true), status);
  assert.equal(projectGitBackupEnabledStatus(null, true), null);
});

test("saved draft redacts credentials and treats blank secret as unchanged", () => {
  const draft = createGitBackupDraft(config);
  assert.equal(draft.oss.accessKeySecret, "");
  assert.equal(isGitBackupDraftDirty(draft, config), false);
  assert.ok(validateGitBackupDraft(draft, config.oss).config);
  assert.equal(
    validateGitBackupDraft(draft, null).error?.id,
    "settings.gitBackup.validation.secretRequired",
  );
  draft.oss.accessKeyId = "different-id";
  assert.equal(hasStoredGitBackupSecret(draft.oss, config.oss), false);
  assert.equal(
    validateGitBackupDraft(draft, config.oss).error?.id,
    "settings.gitBackup.validation.secretRequired",
  );
});

test("interval boundaries, OSS normalization and unsafe targets are validated", () => {
  for (const intervalMinutes of ["", "4", "1441", "5.5", "1e2", "NaN"]) {
    assert.equal(
      validateGitBackupDraft({ oss, intervalMinutes }, null).error?.id,
      "settings.gitBackup.validation.interval",
    );
  }
  for (const intervalMinutes of ["5", "1440"]) {
    assert.equal(validateGitBackupDraft({ oss, intervalMinutes }, null).error, null);
  }
  assert.equal(validateGitBackupOss(oss, null).oss?.region, "oss-cn-hangzhou");
  for (const invalid of [
    { bucket: "Invalid" },
    { region: "https://example.com" },
    { pathPrefix: "../outside" },
  ]) {
    assert.equal(
      validateGitBackupOss({ ...oss, ...invalid }, null).error?.id,
      "settings.gitBackup.validation.oss",
    );
  }
});

test("saved configuration actions require Host credential readiness", () => {
  const target = { workspacePath: "/repo", workspaceIdentity: "remote:one" };
  const ready = { configured: true } as GitBackupStatus;
  assert.equal(canUseSavedGitBackupConfig(config, ready, target), true);
  assert.equal(canUseSavedGitBackupConfig(config, { ...ready, configured: false }, target), false);
  assert.equal(canUseSavedGitBackupConfig(config, null, target), false);
  assert.equal(canUseSavedGitBackupConfig(config, ready, null), false);
  assert.equal(canUseSavedGitBackupConfig({ ...config, oss: null }, ready, target), false);
});

test("remote metadata never permits a local service or credential fallback", () => {
  for (const remote of [
    { workspaceIdentity: "remote:one" },
    { remoteSessionId: "attachment-one" },
    { remoteTarget: { kind: "ssh" } },
  ]) {
    assert.equal(
      resolveGitBackupConnectionKind({ workspacePath: "/same/path", ...remote }, "local-ready"),
      "remote-waiting",
    );
    assert.equal(
      resolveGitBackupConnectionKind({ workspacePath: "/same/path", ...remote }, "remote-ready"),
      "remote-ready",
    );
  }
  assert.equal(
    resolveGitBackupConnectionKind({ workspacePath: "/repo" }, "local-ready"),
    "local-ready",
  );
});

test("manual backup targets identity without saving drafts or enabling auto backup", async () => {
  const calls: unknown[][] = [];
  const service = {
    startBackup: async (...args: unknown[]) => {
      calls.push(args);
    },
  } as unknown as IGitBackupService;
  await runGitBackup(service, { workspacePath: "/same/path", workspaceIdentity: "remote:one" });
  assert.deepEqual(calls, [["/same/path", "remote:one"]]);
});

test("snapshot reads config and status concurrently and rejects read failures", async () => {
  const calls: string[] = [];
  let resolveConfig!: (value: GitBackupConfig) => void;
  const service = {
    getConfig: () => {
      calls.push("config");
      return new Promise<GitBackupConfig>((resolve) => {
        resolveConfig = resolve;
      });
    },
    getStatus: async () => {
      calls.push("status");
      return { running: false };
    },
  } as unknown as IGitBackupService;
  const pending = loadGitBackupSnapshot(service);
  assert.deepEqual(calls, ["config", "status"]);
  resolveConfig(config);
  assert.equal((await pending).config, config);
  await assert.rejects(
    loadGitBackupSnapshot({
      ...service,
      getStatus: async () => {
        throw new Error("offline");
      },
    }),
    /offline/,
  );
});

test("late requests cannot publish after replacement, edit or disposal", () => {
  const scope = createGitBackupRequestScope();
  const first = scope.capture();
  scope.invalidate();
  assert.equal(first(), false);
  const current = scope.capture();
  assert.equal(current(), true);
  scope.dispose();
  assert.equal(current(), false);
});

test("MinIO drafts default region and isolate saved credentials by endpoint", () => {
  const minio = { ...oss, endpoint: "https://storage.example:9000", region: "us-east-1" };
  const saved = { ...config, minio, destinationEnabled: { oss: false, minio: false } };
  const draft = createGitBackupDraft(saved);
  assert.equal(draft.minio.accessKeySecret, "");
  assert.equal(createGitBackupDraft(config).minio.region, "us-east-1");
  assert.equal(validateGitBackupMinio(draft.minio, minio).error, null);
  assert.equal(
    validateGitBackupMinio({ ...draft.minio, endpoint: "https://other.example" }, minio).error?.id,
    "settings.gitBackup.validation.secretRequired",
  );
  assert.equal(
    validateGitBackupMinio({ ...minio, endpoint: "https://storage.example/console" }, null).error
      ?.id,
    "settings.gitBackup.validation.minio",
  );
  assert.equal(
    validateGitBackupMinio({ ...minio, endpoint: "http://storage.example:9000" }, null).minio
      ?.endpoint,
    "http://storage.example:9000",
  );
});

test("provider save explicitly preserves selection and only resets the saved draft", () => {
  const minio = { ...oss, endpoint: "https://storage.example:9000", region: "us-east-1" };
  const saved = { ...config, minio: null, destinationEnabled: { oss: true, minio: false } };
  const draft = { ...createGitBackupDraft(saved), minio };
  draft.oss.bucket = "unsaved-oss-bucket";
  const result = createGitBackupSavePatch(draft, saved, "minio");
  assert.equal(result.error, null);
  assert.deepEqual(result.config, {
    minio,
    intervalMinutes: 60,
    destinationEnabled: { oss: true, minio: false },
  });
  assert.equal("oss" in result.config!, false);
  const accepted = acceptGitBackupDraftSave(draft, { ...saved, minio }, "minio");
  assert.equal(accepted.oss.bucket, "unsaved-oss-bucket");
  assert.equal(accepted.minio.accessKeySecret, "");
  assert.equal(isGitBackupDraftDirty(accepted, { ...saved, minio }, "oss"), true);
  assert.equal(isGitBackupDraftDirty(accepted, { ...saved, minio }, "minio"), false);
});

test("global readiness requires every selected provider but targeted manual backup ignores selection", () => {
  const minio = { ...oss, endpoint: "https://storage.example", region: "us-east-1" };
  const saved = { ...config, minio, destinationEnabled: { oss: true, minio: true } };
  const destination = {
    enabled: true,
    configured: true,
    lastAttemptAt: null,
    lastBackupAt: null,
    lastBackupFiles: 0,
    lastBackupSize: 0,
    lastWorkspacePath: null,
    error: null,
  };
  const ready = {
    ...status,
    running: false,
    destinations: { oss: destination, minio: { ...destination, configured: false } },
  };
  const target = { workspacePath: "/repo" };
  assert.equal(canUseSelectedGitBackupProviders(saved, ready, target), false);
  assert.equal(canUseSavedGitBackupConfig(saved, ready, target, "oss"), true);
  assert.equal(canUseSavedGitBackupConfig(saved, ready, target, "minio"), false);
  assert.equal(
    canUseSelectedGitBackupProviders(
      { ...saved, destinationEnabled: { oss: false, minio: false } },
      ready,
      target,
    ),
    false,
  );
  assert.equal(
    canUseSavedGitBackupConfig(
      { ...saved, destinationEnabled: { oss: false, minio: false } },
      ready,
      target,
      "oss",
    ),
    true,
  );
  assert.equal(
    canUseSelectedGitBackupProviders(
      { ...saved, destinationEnabled: { oss: true, minio: false } },
      ready,
      target,
    ),
    true,
  );
});

test("last destination off projects accepted global disable without losing the other slot", () => {
  const saved = { ...config, enabled: true, destinationEnabled: { oss: true, minio: false } };
  const projected = projectGitBackupDestinationSelection(saved, status, "oss", false);
  assert.equal(projected.config.enabled, false);
  assert.deepEqual(projected.config.destinationEnabled, { oss: false, minio: false });
  assert.equal(projected.config.oss, oss);
  assert.equal(projected.status?.enabled, false);
  assert.equal(projected.status?.nextBackupAt, null);
  assert.equal(saved.enabled, true);
});

test("accepted clear preserves other provider and projects readiness before failed readback", async () => {
  const minio = { ...oss, endpoint: "https://storage.example", region: "us-east-1" };
  const destination = {
    enabled: true,
    configured: true,
    lastAttemptAt: "2026-09-30T00:00:00Z",
    lastBackupAt: "2026-09-30T00:00:00Z",
    lastBackupFiles: 3,
    lastBackupSize: 4096,
    lastWorkspacePath: "/repo",
    error: "old error",
  };
  const saved = {
    ...config,
    minio,
    enabled: true,
    destinationEnabled: { oss: true, minio: false },
  };
  const projected = projectGitBackupDestinationClear(
    saved,
    { ...status, destinations: { oss: destination, minio: { ...destination, enabled: false } } },
    "oss",
  );
  assert.equal(projected.config.oss, null);
  assert.equal(projected.config.minio, minio);
  assert.equal(projected.config.enabled, false);
  assert.equal(projected.status?.configured, true);
  assert.equal(projected.status?.lastBackupAt, null);
  assert.equal(projected.status?.lastBackupFiles, 0);
  assert.equal(projected.status?.lastBackupSize, 0);
  assert.equal(projected.status?.lastWorkspacePath, null);
  assert.equal(projected.status?.error, null);
  assert.equal(projected.status?.nextBackupAt, null);
  assert.deepEqual(projected.status?.destinations?.oss, {
    enabled: false,
    configured: false,
    lastAttemptAt: null,
    lastBackupAt: null,
    lastBackupFiles: 0,
    lastBackupSize: 0,
    lastWorkspacePath: null,
    error: null,
  });
  assert.equal(projected.status?.destinations?.minio?.lastBackupFiles, 3);
  await assert.rejects(
    loadGitBackupSnapshot({
      getConfig: async () => projected.config,
      getStatus: async () => {
        throw new Error("readback unavailable");
      },
    } as unknown as IGitBackupService),
    /readback unavailable/,
  );
  assert.equal(projected.config.enabled, false);
  const stillSelected = projectGitBackupDestinationClear(
    { ...saved, destinationEnabled: { oss: true, minio: true } },
    { ...status, destinations: { oss: destination, minio: destination } },
    "oss",
  );
  assert.equal(stillSelected.config.enabled, true);
  assert.equal(stillSelected.status?.configured, true);
  const noneRemaining = projectGitBackupDestinationClear(config, status, "oss");
  assert.equal(noneRemaining.status?.configured, false);
  const unselected = projectGitBackupDestinationClear(
    { ...saved, destinationEnabled: { oss: false, minio: true } },
    { ...status, lastBackupProviders: ["minio"], errorProviders: ["minio"] },
    "oss",
  );
  assert.equal(unselected.status?.lastBackupAt, status.lastBackupAt);
});

test("unselected manual history is cleared by accepted replacement or removal, not current switches", () => {
  const saved = { ...config, destinationEnabled: { oss: false, minio: true } };
  const recorded: GitBackupStatus = {
    ...status,
    lastBackupProviders: ["oss"],
    errorProviders: ["minio"],
  };
  const cleared = projectGitBackupDestinationClear(saved, recorded, "oss");
  assert.equal(cleared.status?.lastBackupAt, null);
  assert.deepEqual(cleared.status?.lastBackupProviders, []);
  assert.equal(cleared.status?.error, status.error);
  const replacement = { ...saved, oss: { ...oss, bucket: "replacement-bucket" } };
  const replaced = projectGitBackupConfigStatus(saved, replacement, recorded);
  assert.equal(replaced?.lastBackupAt, null);
  assert.equal(replaced?.error, status.error);
  assert.equal(replaced?.destinations?.oss?.lastBackupAt, null);
  const rotated = { ...saved, oss: { ...oss, accessKeySecret: "rotated-secret" } };
  assert.deepEqual(projectGitBackupConfigStatus(saved, rotated, recorded), recorded);
  const unrelated = {
    ...saved,
    minio: { ...oss, endpoint: "https://storage.example", region: "us-east-1" },
  };
  const other = projectGitBackupConfigStatus(saved, unrelated, recorded);
  assert.equal(other?.lastBackupAt, status.lastBackupAt);
  assert.equal(other?.error, null);
  assert.equal(projectGitBackupConfigStatus(saved, replacement, null), null);
});

test("manual provider command forwards target while all-selected retains legacy default", async () => {
  const calls: unknown[][] = [];
  const service = {
    startBackup: async (...args: unknown[]) => {
      calls.push(args);
    },
  } as unknown as IGitBackupService;
  const target = { workspacePath: "/repo", workspaceIdentity: "remote:one" };
  await runGitBackup(service, target, "minio");
  await runGitBackup(service, target);
  assert.deepEqual(calls, [
    ["/repo", "remote:one", "minio"],
    ["/repo", "remote:one"],
  ]);
});

test("private key export uses platform saveFile only and reports cancel/failure truthfully", async () => {
  let payload: unknown;
  const service = { exportPrivateKey: async () => "PRIVATE TEST MATERIAL" } as IGitBackupService;
  const platform = {
    saveFile: async (value: { data: ArrayBuffer }) => {
      payload = { ...value, data: value.data.slice(0) };
      return { success: true };
    },
  } as unknown as IPlatformService;
  assert.equal(await exportGitBackupPrivateKey(service, platform), "saved");
  assert.equal(
    new TextDecoder().decode((payload as { data: ArrayBuffer }).data),
    "PRIVATE TEST MATERIAL",
  );
  assert.equal(
    await exportGitBackupPrivateKey(service, {
      saveFile: async () => ({ success: false, canceled: true }),
    } as unknown as IPlatformService),
    "canceled",
  );
  await assert.rejects(
    exportGitBackupPrivateKey(service, {
      saveFile: async () => ({ success: false, error: "disk full" }),
    } as unknown as IPlatformService),
    /disk full/,
  );
  await assert.rejects(
    exportGitBackupPrivateKey(service, {} as unknown as IPlatformService),
    /unavailable/,
  );
  let saveCalls = 0;
  assert.equal(
    await exportGitBackupPrivateKey(
      service,
      {
        saveFile: async () => {
          saveCalls++;
          return { success: true };
        },
      } as unknown as IPlatformService,
      () => false,
    ),
    "stale",
  );
  assert.equal(saveCalls, 0);
});
