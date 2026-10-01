import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { atomicWritePrivateTextFile } from "@lcode/shared/node";
import {
  createBackupStore,
  EMPTY_BACKUP_STATE,
  EMPTY_BACKUP_DESTINATION_STATE,
} from "./gitBackupStore.js";

const oss = {
  accessKeyId: "fixture-id",
  accessKeySecret: "fixture-secret",
  bucket: "fixture-bucket",
  region: "cn-hangzhou",
};
const minio = {
  endpoint: "http://storage.fixture.invalid:9000",
  accessKeyId: oss.accessKeyId,
  accessKeySecret: "minio-fixture-secret",
  bucket: "minio-fixture-bucket",
  region: "us-east-1",
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "git-backup-store-test-"));
  const dataDir = join(root, "profile");
  const values = new Map<string, string>();
  const credentials = {
    load: async (key: string) => values.get(key) ?? null,
    save: async (key: string, value: string) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
  };
  let failWrites = false;
  const store = createBackupStore(dataDir, credentials, {
    write: async (path, content) => {
      if (failWrites) throw new Error("fixture write failure");
      await atomicWritePrivateTextFile(path, content);
    },
  });
  return {
    root,
    dataDir,
    values,
    credentials,
    store,
    fail: (value: boolean) => {
      failWrites = value;
    },
  };
}

test("failed replacement does not change the committed secret, config or schedule", async () => {
  const f = await fixture();
  try {
    await f.store.configure({ oss }, { workspacePath: f.root }, 0);
    const before = await f.store.loadConfig();
    const saved = new Map(f.values);
    f.fail(true);
    await assert.rejects(
      f.store.configure(
        {
          oss: { ...oss, accessKeySecret: "replacement-secret" },
          enabled: true,
        },
        undefined,
        1,
        { completeOnboarding: true },
      ),
      /write failure/,
    );
    assert.deepEqual(await f.store.loadConfig(), before);
    assert.equal((await f.store.loadState()).nextDueAt, null);
    assert.equal(await f.store.hasCompletedOnboarding(), false);
    assert.equal((await f.store.resolveOss(before.oss!)).accessKeySecret, oss.accessKeySecret);
    assert.deepEqual(f.values, saved);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("enabling commits configuration, due time and onboarding together", async () => {
  const f = await fixture();
  try {
    await f.store.configure(
      { oss, enabled: true, intervalMinutes: 5 },
      { workspacePath: f.root },
      100,
      { completeOnboarding: true },
    );
    assert.equal((await f.store.loadConfig()).enabled, true);
    assert.equal((await f.store.loadState()).nextDueAt, 300100);
    assert.equal(await f.store.hasCompletedOnboarding(), true);
    const json = await readFile(join(f.dataDir, "git-backup-config.json"), "utf8");
    assert.ok(!json.includes(oss.accessKeySecret));
    f.fail(true);
    await assert.rejects(f.store.configure({ enabled: false }, undefined, 200), /write failure/);
    assert.equal((await f.store.loadConfig()).enabled, true);
    assert.equal((await f.store.loadState()).nextDueAt, 300100);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("credential references survive copying the profile to a new absolute path", async () => {
  const f = await fixture();
  try {
    await f.store.configure({ oss }, undefined, 0);
    const destination = join(f.root, "moved-profile");
    await cp(f.dataDir, destination, { recursive: true });
    const moved = createBackupStore(destination, f.credentials);
    assert.equal((await moved.getStatus()).configured, true);
    assert.equal(
      (await moved.resolveOss((await moved.loadConfig()).oss!)).accessKeySecret,
      oss.accessKeySecret,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("legacy state, marker and credential key migrate once without plaintext secrets", async () => {
  const f = await fixture();
  try {
    await mkdir(f.dataDir);
    const oldKey = `git-backup:${createHash("sha256").update(f.dataDir).digest("hex").slice(0, 24)}:${oss.accessKeyId}`;
    f.values.set(oldKey, oss.accessKeySecret);
    await writeFile(
      join(f.dataDir, "git-backup-config.json"),
      JSON.stringify({
        enabled: true,
        intervalMinutes: 5,
        oss: { ...oss, accessKeySecret: "" },
        workspaces: [{ workspacePath: f.root }],
      }),
    );
    await writeFile(
      join(f.dataDir, "git-backup-state.json"),
      JSON.stringify({
        ...EMPTY_BACKUP_STATE,
        nextDueAt: 123,
        running: true,
      }),
    );
    await writeFile(join(f.dataDir, "git-backup-onboarding-done"), "fixture");
    assert.equal((await f.store.loadState()).nextDueAt, 123);
    assert.equal(await f.store.hasCompletedOnboarding(), true);
    assert.equal((await f.store.getStatus()).configured, true);
    await writeFile(join(f.dataDir, "git-backup-state.json"), "corrupt legacy state");
    assert.equal((await f.store.loadState()).running, true);
    const destination = join(f.root, "moved-profile");
    await cp(f.dataDir, destination, { recursive: true });
    assert.equal(
      (await createBackupStore(destination, f.credentials).getStatus()).configured,
      true,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("concurrent state and configuration writes retain both changes", async () => {
  const f = await fixture();
  try {
    await f.store.configure({ oss }, { workspacePath: f.root }, 0);
    const second = createBackupStore(f.dataDir, f.credentials);
    await Promise.all([
      f.store.configure({ intervalMinutes: 7 }, undefined, 0),
      second.updateState((state) => ({ ...state, lastBackupFiles: 42 })),
      second.markOnboardingComplete(),
    ]);
    assert.equal((await f.store.loadConfig()).intervalMinutes, 7);
    assert.equal((await f.store.loadState()).lastBackupFiles, 42);
    assert.equal(await f.store.hasCompletedOnboarding(), true);
    await f.store.configure({ enabled: true }, undefined, 0);
    await f.store.removeWorkspace({ workspacePath: f.root });
    assert.equal((await second.getStatus()).enabled, false);
    assert.equal((await second.loadState()).nextDueAt, null);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("explicit selection saves unselected slots while legacy OSS save remains selected", async () => {
  const f = await fixture();
  try {
    assert.deepEqual((await f.store.loadConfig()).destinationEnabled, { oss: false, minio: false });
    await f.store.configure({ minio }, undefined, 0);
    assert.deepEqual((await f.store.loadConfig()).destinationEnabled, { oss: false, minio: false });
    await f.store.configure({ oss, destinationEnabled: { oss: false } }, undefined, 0);
    assert.deepEqual((await f.store.loadConfig()).destinationEnabled, { oss: false, minio: false });
    await assert.rejects(
      f.store.configure({ enabled: true }, { workspacePath: f.root }, 0),
      /requires/,
    );
    await f.store.configure({ oss: null }, undefined, 0);
    await f.store.configure({ oss }, undefined, 0);
    assert.deepEqual((await f.store.loadConfig()).destinationEnabled, { oss: true, minio: false });
    await f.store.configure({ destinationEnabled: { minio: true } }, undefined, 0);
    assert.deepEqual((await f.store.loadConfig()).destinationEnabled, { oss: true, minio: true });
    const config = await f.store.loadConfig();
    assert.equal(config.oss!.accessKeySecret, "");
    assert.equal(config.minio!.accessKeySecret, "");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("version one migration preserves the exact reference, schedule and OSS-only history", async () => {
  const f = await fixture();
  try {
    await mkdir(f.dataDir);
    const reference = "git-backup:immutable-v1-reference:fixture-id";
    f.values.set(reference, oss.accessKeySecret);
    const historical = {
      ...EMPTY_BACKUP_STATE,
      nextDueAt: 987,
      lastBackupAt: "2026-01-02T00:00:00.000Z",
      lastBackupFiles: 7,
      lastBackupSize: 42,
      lastWorkspacePath: f.root,
    };
    await writeFile(
      join(f.dataDir, "git-backup-config.json"),
      JSON.stringify({
        enabled: false,
        intervalMinutes: 5,
        oss: { ...oss, accessKeySecret: "" },
        workspaces: [{ workspacePath: f.root, workspaceIdentity: "remote-fixture" }],
        _backup: {
          version: 1,
          state: historical,
          credentialReference: reference,
          onboardingComplete: true,
        },
      }),
    );
    const config = await f.store.loadConfig();
    assert.deepEqual(config.destinationEnabled, { oss: true, minio: false });
    assert.equal(config.enabled, false);
    const state = await f.store.loadState();
    assert.equal(state.nextDueAt, 987);
    assert.equal(state.destinations!.oss!.lastBackupAt, historical.lastBackupAt);
    assert.equal(state.destinations!.oss!.lastBackupFiles, 7);
    assert.equal(state.destinations!.minio, undefined);
    const saved = JSON.parse(await readFile(join(f.dataDir, "git-backup-config.json"), "utf8"));
    assert.equal(saved._backup.version, 2);
    assert.deepEqual(saved._backup.credentialReferences, { oss: reference, minio: null });
    assert.equal(await f.store.hasCompletedOnboarding(), true);
    const destination = join(f.root, "moved-v2-profile");
    await cp(f.dataDir, destination, { recursive: true });
    const reopened = createBackupStore(destination, f.credentials);
    assert.equal(
      (await reopened.resolveOss((await reopened.loadConfig()).oss!)).accessKeySecret,
      oss.accessKeySecret,
    );
    assert.equal((await reopened.getStatus()).destinations!.minio!.lastBackupAt, null);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("provider credentials are isolated and MinIO blank secrets require the same normalized origin", async () => {
  const f = await fixture();
  try {
    await f.store.configure({ oss, minio }, undefined, 0);
    const config = await f.store.loadConfig();
    assert.equal((await f.store.resolveOss(config.oss!)).accessKeySecret, oss.accessKeySecret);
    const resolved = await f.store.resolveDestination("minio", {
      ...config.minio!,
      endpoint: `${minio.endpoint}/`,
    });
    assert.equal(resolved.accessKeySecret, minio.accessKeySecret);
    await assert.rejects(
      f.store.resolveDestination("minio", {
        ...config.minio!,
        endpoint: "https://other.fixture.invalid",
      }),
      /endpoint.*new secret/i,
    );
    await assert.rejects(
      f.store.resolveDestination("minio", { ...config.minio!, accessKeyId: "other-id" }),
      /new secret/,
    );
    await f.store.configure(
      {
        minio: {
          ...minio,
          endpoint: "https://other.fixture.invalid",
          accessKeySecret: "replacement-minio-secret",
        },
      },
      undefined,
      0,
    );
    assert.equal(
      (await f.store.resolveOss((await f.store.loadConfig()).oss!)).accessKeySecret,
      oss.accessKeySecret,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("all staged provider references roll back on atomic document failure", async () => {
  const f = await fixture();
  try {
    await f.store.configure({ oss, minio }, { workspacePath: f.root }, 0);
    const before = await f.store.loadConfig();
    const saved = new Map(f.values);
    f.fail(true);
    await assert.rejects(
      f.store.configure(
        {
          oss: { ...oss, accessKeySecret: "replacement-oss-secret" },
          minio: { ...minio, accessKeySecret: "replacement-minio-secret" },
          destinationEnabled: { oss: true, minio: true },
          enabled: true,
        },
        undefined,
        0,
        { completeOnboarding: true },
      ),
      /write failure/,
    );
    assert.deepEqual(await f.store.loadConfig(), before);
    assert.deepEqual(f.values, saved);
    assert.equal((await f.store.loadState()).nextDueAt, null);
    assert.equal(await f.store.hasCompletedOnboarding(), false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("credential save failure cleans every staged reference without altering accepted configuration", async () => {
  const f = await fixture();
  try {
    await f.store.configure({ oss, minio }, undefined, 0);
    const before = await f.store.loadConfig();
    const saved = new Map(f.values);
    const save = f.credentials.save;
    let writes = 0;
    f.credentials.save = async (key, value) => {
      await save(key, value);
      if (++writes === 2) throw new Error(`fixture credential failure ${minio.accessKeySecret}`);
    };
    await assert.rejects(
      f.store.configure(
        {
          oss: { ...oss, accessKeySecret: "new-oss-secret" },
          minio: { ...minio, accessKeySecret: "new-minio-secret" },
        },
        undefined,
        0,
      ),
      (error) => error instanceof Error && error.message === "MinIO credentials could not be saved",
    );
    assert.deepEqual(await f.store.loadConfig(), before);
    assert.deepEqual(f.values, saved);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("enabling requires every selected credential but disabling skips unchanged credential lookups", async () => {
  const f = await fixture();
  try {
    await f.store.configure(
      { oss, minio, destinationEnabled: { oss: true, minio: true } },
      { workspacePath: f.root },
      0,
    );
    const saved = JSON.parse(await readFile(join(f.dataDir, "git-backup-config.json"), "utf8"));
    f.values.delete(saved._backup.credentialReferences.minio);
    await assert.rejects(
      f.store.configure({ enabled: true }, undefined, 0),
      /MinIO.*not configured/,
    );
    assert.equal((await f.store.loadConfig()).enabled, false);
    await f.store.configure({ minio, enabled: true }, undefined, 100);
    f.credentials.load = async () => {
      throw new Error("lookup must not happen");
    };
    await f.store.configure({ destinationEnabled: { minio: false } }, undefined, 200);
    assert.equal((await f.store.loadConfig()).enabled, true);
    await f.store.configure({ destinationEnabled: { oss: false } }, undefined, 300);
    assert.equal((await f.store.loadConfig()).enabled, false);
    assert.equal((await f.store.loadState()).nextDueAt, null);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("per-provider history resets on destination changes while disabled toggles preserve it", async () => {
  const f = await fixture();
  try {
    await f.store.configure({ oss, minio }, undefined, 0);
    const success = {
      ...EMPTY_BACKUP_DESTINATION_STATE,
      lastAttemptAt: "attempt",
      lastBackupAt: "success",
      lastBackupFiles: 3,
      lastBackupSize: 9,
      lastWorkspacePath: f.root,
    };
    await f.store.updateState((state) => ({
      ...state,
      destinations: { oss: success, minio: success },
    }));
    await f.store.configure({ destinationEnabled: { oss: false, minio: false } }, undefined, 0);
    assert.equal((await f.store.loadState()).destinations!.oss!.lastBackupAt, "success");
    await f.store.configure(
      { minio: { ...minio, accessKeySecret: "", bucket: "another-fixture-bucket" } },
      undefined,
      0,
    );
    assert.deepEqual(
      (await f.store.loadState()).destinations!.minio,
      EMPTY_BACKUP_DESTINATION_STATE,
    );
    assert.equal((await f.store.loadState()).destinations!.oss!.lastBackupAt, "success");
    await f.store.configure(
      { oss: { ...oss, accessKeyId: "changed-id", accessKeySecret: "changed-secret" } },
      undefined,
      0,
    );
    assert.deepEqual((await f.store.loadState()).destinations!.oss, EMPTY_BACKUP_DESTINATION_STATE);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("status reflects actual saved credentials independently of destination selection", async () => {
  const f = await fixture();
  try {
    await f.store.configure(
      { oss, minio, destinationEnabled: { oss: false, minio: true } },
      undefined,
      0,
    );
    await f.store.updateState((state) => ({
      ...state,
      destinations: {
        minio: {
          ...EMPTY_BACKUP_DESTINATION_STATE,
          lastAttemptAt: "attempt",
          error: "fixture upload failed",
        },
      },
    }));
    const saved = JSON.parse(await readFile(join(f.dataDir, "git-backup-config.json"), "utf8"));
    f.values.delete(saved._backup.credentialReferences.minio);
    const status = await f.store.getStatus();
    assert.equal(status.configured, true);
    assert.equal(status.destinations!.oss!.enabled, false);
    assert.equal(status.destinations!.oss!.configured, true);
    assert.equal(status.destinations!.minio!.enabled, true);
    assert.equal(status.destinations!.minio!.configured, false);
    assert.equal(status.destinations!.minio!.error, "fixture upload failed");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("admission freezes credentials, reports independent errors and retains retired references", async () => {
  const f = await fixture();
  try {
    await f.store.configure(
      { oss, minio, destinationEnabled: { oss: true, minio: true } },
      undefined,
      0,
    );
    const before = JSON.parse(await readFile(join(f.dataDir, "git-backup-config.json"), "utf8"));
    f.values.delete(before._backup.credentialReferences.minio);
    const admission = await f.store.loadAdmission();
    assert.equal(admission.config.oss!.accessKeySecret, "");
    assert.equal(admission.destinations[0]!.config!.accessKeySecret, oss.accessKeySecret);
    assert.match(admission.destinations[1]!.error!, /MinIO.*not configured/);
    await f.store.configure(
      { oss: { ...oss, accessKeySecret: "replacement-secret" } },
      undefined,
      0,
    );
    assert.equal(admission.destinations[0]!.config!.accessKeySecret, oss.accessKeySecret);
    assert.equal(f.values.get(before._backup.credentialReferences.oss), oss.accessKeySecret);
    const explicit = await f.store.loadAdmission("oss");
    assert.equal(explicit.destinations.length, 1);
    assert.equal(explicit.destinations[0]!.config!.accessKeySecret, "replacement-secret");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("state updates receive current configuration under the same document lock", async () => {
  const f = await fixture();
  try {
    await f.store.configure({ minio }, undefined, 0);
    await f.store.updateState((state, config) => ({
      ...state,
      lastWorkspacePath: config.minio!.endpoint,
    }));
    assert.equal((await f.store.loadState()).lastWorkspacePath, minio.endpoint);
    const second = createBackupStore(f.dataDir, f.credentials);
    await Promise.all([
      f.store.configure({ destinationEnabled: { minio: true } }, undefined, 0),
      second.configure({ oss, destinationEnabled: { oss: true } }, undefined, 0),
    ]);
    assert.deepEqual((await f.store.loadConfig()).destinationEnabled, { oss: true, minio: true });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("invalid version-two metadata and selection are rejected without overwrite", async () => {
  const f = await fixture();
  try {
    await f.store.loadConfig();
    const path = join(f.dataDir, "git-backup-config.json");
    const original = JSON.parse(await readFile(path, "utf8"));
    for (const change of [
      { ...original, destinationEnabled: { oss: "true", minio: false } },
      {
        ...original,
        _backup: { ...original._backup, credentialReferences: { oss: 123, minio: null } },
      },
      {
        ...original,
        _backup: {
          ...original._backup,
          state: { ...original._backup.state, destinations: { minio: { lastAttemptAt: 123 } } },
        },
      },
    ]) {
      const content = JSON.stringify(change);
      await writeFile(path, content);
      await assert.rejects(f.store.loadConfig(), /Invalid/);
      assert.equal(await readFile(path, "utf8"), content);
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("credential lookup failures stay provider-local and never expose backend details", async () => {
  const f = await fixture();
  try {
    await f.store.configure(
      { oss, minio, destinationEnabled: { oss: true, minio: true } },
      undefined,
      0,
    );
    const load = f.credentials.load;
    f.credentials.load = async (key) => {
      if (key.includes(":minio:"))
        throw new Error(`sensitive backend detail ${minio.accessKeySecret}`);
      return load(key);
    };
    const status = await f.store.getStatus();
    assert.equal(status.configured, true);
    assert.equal(status.destinations!.oss!.configured, true);
    assert.equal(status.destinations!.minio!.configured, false);
    assert.equal(status.destinations!.minio!.error, "MinIO credentials could not be loaded");
    const admission = await f.store.loadAdmission();
    assert.equal(admission.destinations[0]!.config!.accessKeySecret, oss.accessKeySecret);
    assert.equal(admission.destinations[1]!.error, "MinIO credentials could not be loaded");
    assert.ok(!JSON.stringify(status).includes(minio.accessKeySecret));
    assert.ok(!JSON.stringify(admission.destinations[1]).includes(minio.accessKeySecret));
    await f.store.updateState((state) => ({
      ...state,
      destinations: {
        minio: { ...EMPTY_BACKUP_DESTINATION_STATE, error: "persisted upload failure" },
      },
    }));
    assert.equal(
      (await f.store.getStatus()).destinations!.minio!.error,
      "persisted upload failure",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("recorded provider location changes clear aggregate success; secret rotation preserves history", async () => {
  const f = await fixture();
  try {
    await f.store.configure({ oss }, undefined, 0);
    const success = {
      ...EMPTY_BACKUP_DESTINATION_STATE,
      lastAttemptAt: "attempt",
      lastBackupAt: "success",
      lastBackupFiles: 3,
      lastBackupSize: 9,
      lastWorkspacePath: f.root,
    };
    await f.store.updateState((state) => ({
      ...state,
      lastBackupAt: "success",
      lastBackupFiles: 3,
      lastBackupSize: 9,
      lastWorkspacePath: f.root,
      lastBackupProviders: ["oss"],
      destinations: { oss: success },
    }));
    await f.store.configure({ minio }, undefined, 0);
    assert.equal((await f.store.loadState()).lastBackupAt, "success");
    await f.store.configure(
      { oss: { ...oss, accessKeySecret: "rotated-fixture-secret" } },
      undefined,
      0,
    );
    assert.equal((await f.store.loadState()).lastBackupAt, "success");
    assert.equal((await f.store.loadState()).destinations!.oss!.lastBackupAt, "success");
    await f.store.configure(
      { oss: { ...oss, bucket: "changed-fixture-bucket", accessKeySecret: "" } },
      undefined,
      0,
    );
    const state = await f.store.loadState();
    assert.equal(state.lastBackupAt, null);
    assert.equal(state.lastBackupFiles, 0);
    assert.equal(state.lastBackupSize, 0);
    assert.equal(state.lastWorkspacePath, null);
    assert.deepEqual(state.destinations!.oss, EMPTY_BACKUP_DESTINATION_STATE);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("clearing a disabled provider preserves the healthy schedule and admitted credentials", async () => {
  const f = await fixture();
  try {
    await f.store.configure(
      { oss, minio, destinationEnabled: { oss: true, minio: true }, enabled: true },
      { workspacePath: f.root },
      0,
    );
    const before = JSON.parse(await readFile(join(f.dataDir, "git-backup-config.json"), "utf8"));
    const admission = await f.store.loadAdmission();
    f.credentials.load = async () => {
      throw new Error("credentials must not be read while disabling");
    };
    await f.store.configure({ minio: null, destinationEnabled: { minio: false } }, undefined, 1);
    assert.equal((await f.store.loadConfig()).enabled, true);
    assert.equal((await f.store.loadConfig()).minio, null);
    assert.equal((await f.store.loadState()).nextDueAt, 3_600_000);
    assert.equal(f.values.get(before._backup.credentialReferences.minio), minio.accessKeySecret);
    assert.equal(admission.destinations[1]!.config!.accessKeySecret, minio.accessKeySecret);
    await f.store.configure({ oss: null, destinationEnabled: { oss: false } }, undefined, 2);
    assert.equal((await f.store.loadConfig()).enabled, false);
    assert.equal((await f.store.loadState()).nextDueAt, null);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
