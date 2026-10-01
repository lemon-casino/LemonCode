import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createGitBackupService, type GitBackupServiceOptions } from "./gitBackupService.js";
import type { GitBackupProvider } from "./gitBackup.js";

const oss = {
  accessKeyId: "fixture-id",
  accessKeySecret: "fixture-secret",
  bucket: "fixture-bucket",
  region: "cn-hangzhou",
  pathPrefix: "oss-history",
};
const minio = {
  endpoint: "http://127.0.0.1:9000",
  accessKeyId: "fixture-id",
  accessKeySecret: "minio-fixture-secret",
  bucket: "fixture-bucket",
  region: "us-east-1",
  pathPrefix: "minio-history",
};
async function fixture(fetch: typeof globalThis.fetch, options: GitBackupServiceOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "git-backup-destinations-test-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, ".git", "objects"), { recursive: true });
  await writeFile(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(workspace, ".git", "objects", "fixture"), Buffer.from([0, 1, 255]));
  const secrets = new Map<string, string>();
  const credentialService = {
    async load(key: string) {
      return secrets.get(key) ?? null;
    },
    async save(key: string, value: string) {
      secrets.set(key, value);
    },
    async delete(key: string) {
      secrets.delete(key);
    },
  };
  const service = createGitBackupService(join(root, "profile"), {
    ...options,
    fetch,
    credentialService,
  });
  return {
    root,
    workspace,
    service,
    credentialService,
    async close() {
      service.dispose();
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}
function providerOf(url: string): GitBackupProvider {
  return new URL(url).hostname.endsWith("aliyuncs.com") ? "oss" : "minio";
}
async function waitFor(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await sleep(10);
  }
  assert.fail("Scheduled backup did not reach the expected state");
}

for (const selected of ["minio", "both"] as const) {
  test(`scheduled ${selected} destinations run and preserve the next due time`, async () => {
    let now = Date.now();
    const calls: GitBackupProvider[] = [];
    const f = await fixture(
      async (url) => {
        calls.push(providerOf(String(url)));
        return new Response(null, { status: 200 });
      },
      { now: () => now, schedulerPollMs: 10 },
    );
    try {
      await f.service.configure(
        {
          oss,
          minio,
          destinationEnabled: { oss: selected === "both", minio: true },
          enabled: true,
          intervalMinutes: 5,
        },
        { workspacePath: f.workspace },
      );
      now += 300_001;
      await waitFor(async () => {
        const status = await f.service.getStatus();
        return status.lastBackupAt !== null && Date.parse(status.nextBackupAt!) > now;
      });
      assert.equal(calls.filter((provider) => provider === "minio").length, 4);
      assert.equal(
        calls.filter((provider) => provider === "oss").length,
        selected === "both" ? 4 : 0,
      );
      assert.equal((await f.service.getStatus()).error, null);
    } finally {
      await f.close();
    }
  });
}

test("destination disabled during a scheduled run is excluded from the next workspace admission", async () => {
  let now = Date.now();
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const calls: GitBackupProvider[] = [];
  const f = await fixture(
    async (url) => {
      calls.push(providerOf(String(url)));
      started();
      await gate;
      return new Response(null, { status: 200 });
    },
    { now: () => now, schedulerPollMs: 10 },
  );
  try {
    await f.service.configure(
      {
        oss,
        minio,
        enabled: true,
        intervalMinutes: 5,
        destinationEnabled: { oss: true, minio: true },
      },
      { workspacePath: f.workspace, workspaceIdentity: "first" },
    );
    await f.service.configure({}, { workspacePath: f.workspace, workspaceIdentity: "second" });
    now += 300_001;
    await ready;
    await f.service.configure({ destinationEnabled: { minio: false } });
    release();
    await waitFor(async () => {
      const status = await f.service.getStatus();
      return status.lastBackupAt !== null && Date.parse(status.nextBackupAt!) > now;
    });
    assert.equal(calls.filter((provider) => provider === "minio").length, 4);
    assert.equal(calls.filter((provider) => provider === "oss").length, 8);
    assert.equal((await f.service.getConfig()).enabled, true);
  } finally {
    release?.();
    await f.service.stopBackup();
    await waitFor(async () => !(await f.service.getStatus()).running);
    await f.close();
  }
});

test("both selected destinations receive identical encrypted snapshot and their own last manifest", async () => {
  const calls: Array<{ provider: GitBackupProvider; key: string; data: Buffer }> = [];
  const f = await fixture(async (url, init) => {
    calls.push({
      provider: providerOf(String(url)),
      key: new URL(String(url)).pathname,
      data: Buffer.from(init!.body as Uint8Array),
    });
    return new Response(null, { status: 200 });
  });
  try {
    await f.service.configure({ oss, minio, destinationEnabled: { oss: true, minio: true } });
    const manifest = await f.service.startBackup(f.workspace, "fixture-identity");
    assert.equal(calls.length, 8);
    for (const provider of ["oss", "minio"] as const) {
      const own = calls.filter((call) => call.provider === provider);
      assert.ok(own.at(-1)!.key.endsWith("manifest.json"));
      assert.equal(JSON.parse(own.at(-1)!.data.toString()).createdAt, manifest.createdAt);
      const status = (await f.service.getStatus()).destinations![provider]!;
      assert.equal(status.lastBackupAt, manifest.createdAt);
      assert.equal(status.error, null);
    }
    for (const name of ["data.enc", "key.enc", "iv.bin"]) {
      const pair = calls.filter((call) => call.key.endsWith(name));
      assert.deepEqual(pair[0]!.data, pair[1]!.data);
      assert.equal(pair[0]!.key.split("/").at(-2), pair[1]!.key.split("/").at(-2));
    }
  } finally {
    await f.close();
  }
});

for (const failed of ["oss", "minio"] as const) {
  test(`${failed} failure does not prevent the other destination completion`, async () => {
    const calls: Array<{ provider: GitBackupProvider; key: string }> = [];
    const f = await fixture(async (url) => {
      const provider = providerOf(String(url));
      calls.push({ provider, key: String(url) });
      return new Response(null, { status: provider === failed ? 403 : 200 });
    });
    try {
      await f.service.configure({ oss, minio, destinationEnabled: { oss: true, minio: true } });
      await assert.rejects(f.service.startBackup(f.workspace), (error) => {
        const value = error as Error & { code?: string; details?: { destinations?: unknown[] } };
        assert.equal(value.code, "GIT_BACKUP_DESTINATION_FAILED");
        assert.equal(value.details?.destinations?.length, 2);
        assert.match(value.message, /HTTP 403/);
        assert.ok(!value.message.includes(minio.accessKeySecret));
        return true;
      });
      assert.ok(
        !calls.some((call) => call.provider === failed && call.key.endsWith("manifest.json")),
      );
      const succeeded = failed === "oss" ? "minio" : "oss";
      assert.ok(
        calls.some((call) => call.provider === succeeded && call.key.endsWith("manifest.json")),
      );
      const status = await f.service.getStatus();
      assert.equal(status.lastBackupAt, null);
      assert.equal(status.running, false);
      assert.equal(status.destinations![failed]!.lastBackupAt, null);
      assert.match(status.destinations![failed]!.error!, /HTTP 403/);
      assert.ok(status.destinations![succeeded]!.lastBackupAt);
    } finally {
      await f.close();
    }
  });
}

test("manual provider selection works while disabled and default rejects empty selection", async () => {
  const calls: GitBackupProvider[] = [];
  const f = await fixture(async (url) => {
    calls.push(providerOf(String(url)));
    return new Response(null, { status: 200 });
  });
  try {
    await f.service.configure({ oss, minio, destinationEnabled: { oss: false, minio: false } });
    await assert.rejects(
      f.service.startBackup(f.workspace),
      /destination.*selected|not configured/,
    );
    assert.equal(calls.length, 0);
    await f.service.startBackup(f.workspace, undefined, "minio");
    assert.deepEqual(calls, ["minio", "minio", "minio", "minio"]);
    calls.length = 0;
    await f.service.configure({ destinationEnabled: { oss: true } });
    await f.service.startBackup(f.workspace);
    assert.deepEqual(calls, ["oss", "oss", "oss", "oss"]);
    assert.equal((await f.service.getConfig()).enabled, false);
  } finally {
    await f.close();
  }
});

test("missing one provider credential still backs up the healthy provider", async () => {
  const calls: GitBackupProvider[] = [];
  const f = await fixture(async (url) => {
    calls.push(providerOf(String(url)));
    return new Response(null, { status: 200 });
  });
  try {
    await f.service.configure({ oss, minio, destinationEnabled: { oss: true, minio: true } });
    const load = f.credentialService.load;
    f.credentialService.load = async (key) => (key.includes(":minio:") ? null : load(key));
    await assert.rejects(f.service.startBackup(f.workspace), /Secret is not configured/);
    assert.deepEqual(calls, ["oss", "oss", "oss", "oss"]);
    const status = await f.service.getStatus();
    assert.ok(status.destinations!.oss!.lastBackupAt);
    assert.equal(status.destinations!.minio!.configured, false);
  } finally {
    await f.close();
  }
});

test("all destination uploads settle before releasing the profile execution lock", async () => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const f = await fixture(async (url) => {
    if (providerOf(String(url)) === "oss") return new Response(null, { status: 403 });
    started();
    await gate;
    return new Response(null, { status: 200 });
  });
  let run: Promise<unknown> | undefined;
  try {
    await f.service.configure({ oss, minio, destinationEnabled: { oss: true, minio: true } });
    run = f.service.startBackup(f.workspace).catch((error) => error);
    await ready;
    assert.equal((await f.service.getStatus()).running, true);
    await assert.rejects(f.service.startBackup(f.workspace, undefined, "oss"), /already running/);
    await f.service.stopBackup();
    release();
    assert.match(((await run) as Error).message, /HTTP 403/);
    assert.ok((await f.service.getStatus()).destinations!.minio!.lastBackupAt);
  } finally {
    release?.();
    await run;
    await f.close();
  }
});

test("an admitted run freezes destination configs and does not label a replacement bucket as backed up", async () => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const urls: string[] = [];
  const f = await fixture(async (url) => {
    urls.push(String(url));
    started();
    await gate;
    return new Response(null, { status: 200 });
  });
  let run: Promise<unknown> | undefined;
  try {
    await f.service.configure({ minio, destinationEnabled: { minio: true } });
    run = f.service.startBackup(f.workspace);
    await ready;
    await f.service.configure({
      minio: { ...minio, bucket: "replacement-bucket", accessKeySecret: "" },
    });
    release();
    await run;
    assert.ok(urls.every((url) => new URL(url).pathname.startsWith("/fixture-bucket/")));
    const status = await f.service.getStatus();
    assert.equal(status.destinations!.minio!.lastBackupAt, null);
    assert.equal(status.lastBackupAt, null);
  } finally {
    release?.();
    await run;
    await f.close();
  }
});
