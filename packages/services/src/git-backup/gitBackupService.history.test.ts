import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createGitBackupService } from "./gitBackupService.js";

const oss = {
  accessKeyId: "fixture-id",
  accessKeySecret: "fixture-secret",
  bucket: "fixture-bucket",
  region: "cn-hangzhou",
};
const minio = { ...oss, endpoint: "http://127.0.0.1:9000", region: "us-east-1" };
async function fixture(fetch: typeof globalThis.fetch, scheduled = false) {
  const root = await mkdtemp(join(tmpdir(), "git-backup-history-test-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, ".git"), { recursive: true });
  await writeFile(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n");
  const secrets = new Map<string, string>();
  let now = Date.now();
  const service = createGitBackupService(join(root, "profile"), {
    fetch,
    now: () => now,
    schedulerPollMs: scheduled ? 10 : 60_000,
    credentialService: {
      load: async (key) => secrets.get(key) ?? null,
      save: async (key, value) => {
        secrets.set(key, value);
      },
      delete: async (key) => {
        secrets.delete(key);
      },
    },
  });
  return {
    service,
    workspace,
    due: () => {
      now += 300_001;
    },
    finishedCycle: async () => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const status = await service.getStatus();
        if (!status.running && status.nextBackupAt && Date.parse(status.nextBackupAt) > now) return;
        await sleep(10);
      }
      assert.fail("Scheduled cycle did not finish");
    },
    close: async () => {
      service.dispose();
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

for (const change of ["replace", "clear"] as const) {
  test(`unselected explicit success is invalidated on ${change} but unrelated history survives`, async () => {
    const f = await fixture(async () => new Response(null, { status: 200 }));
    try {
      await f.service.configure({ oss, minio, destinationEnabled: { oss: false, minio: false } });
      const first = await f.service.startBackup(f.workspace, undefined, "oss");
      await f.service.configure({
        minio: { ...minio, bucket: "unrelated-bucket", accessKeySecret: "" },
      });
      assert.equal((await f.service.getStatus()).lastBackupAt, first.createdAt);
      await f.service.startBackup(f.workspace, undefined, "minio");
      assert.ok((await f.service.getStatus()).lastBackupAt);
      await f.service.configure({
        minio:
          change === "clear"
            ? null
            : { ...minio, bucket: "replacement-bucket", accessKeySecret: "" },
      });
      const status = await f.service.getStatus();
      assert.equal(status.lastBackupAt, null);
      assert.equal(status.lastBackupFiles, 0);
      assert.equal(status.lastBackupSize, 0);
      assert.equal(status.lastWorkspacePath, null);
      assert.equal(status.destinations!.minio!.lastBackupAt, null);
      assert.equal(status.destinations!.oss!.lastBackupAt, first.createdAt);
    } finally {
      await f.close();
    }
  });
}

test("changing an unselected failed destination clears only its aggregate error", async () => {
  const f = await fixture(async () => new Response(null, { status: 403 }));
  try {
    await f.service.configure({ oss, minio, destinationEnabled: { oss: false, minio: false } });
    await assert.rejects(f.service.startBackup(f.workspace, undefined, "minio"), /HTTP 403/);
    await f.service.configure({ oss: { ...oss, bucket: "unrelated-bucket", accessKeySecret: "" } });
    assert.match((await f.service.getStatus()).error!, /HTTP 403/);
    await f.service.configure({
      minio: { ...minio, bucket: "replacement-bucket", accessKeySecret: "" },
    });
    assert.equal((await f.service.getStatus()).error, null);
  } finally {
    await f.close();
  }
});

for (const scheduled of [false, true]) {
  test(`${scheduled ? "scheduled" : "manual"} old-location failure does not pollute replacement status`, async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const f = await fixture(async () => {
      started();
      await gate;
      return new Response(null, { status: 403 });
    }, scheduled);
    let run: Promise<unknown> | undefined;
    try {
      await f.service.configure(
        { minio, enabled: scheduled, intervalMinutes: 5, destinationEnabled: { minio: true } },
        { workspacePath: f.workspace },
      );
      if (scheduled) f.due();
      else run = f.service.startBackup(f.workspace).catch((error) => error);
      await ready;
      await f.service.configure({
        minio: { ...minio, bucket: "replacement-bucket", accessKeySecret: "" },
      });
      release();
      if (scheduled) await f.finishedCycle();
      else assert.match(((await run) as Error).message, /HTTP 403/);
      const status = await f.service.getStatus();
      assert.equal(status.error, null);
      assert.equal(status.destinations!.minio!.error, null);
      assert.equal(status.destinations!.minio!.lastAttemptAt, null);
      assert.equal(status.running, false);
    } finally {
      release?.();
      await run;
      await f.close();
    }
  });
}

test("a valid sibling failure remains visible when another location was replaced", async () => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const f = await fixture(async () => {
    started();
    await gate;
    return new Response(null, { status: 403 });
  }, true);
  try {
    await f.service.configure(
      {
        oss,
        minio,
        enabled: true,
        intervalMinutes: 5,
        destinationEnabled: { oss: true, minio: true },
      },
      { workspacePath: f.workspace },
    );
    f.due();
    await ready;
    await f.service.configure({
      minio: { ...minio, bucket: "replacement-bucket", accessKeySecret: "" },
    });
    release();
    await f.finishedCycle();
    const status = await f.service.getStatus();
    assert.match(status.error!, /oss.*HTTP 403/);
    assert.ok(!status.error!.includes("minio:"));
    assert.match(status.destinations!.oss!.error!, /HTTP 403/);
    assert.equal(status.destinations!.minio!.error, null);
  } finally {
    release?.();
    await f.close();
  }
});
