import assert from "node:assert/strict";
import { createHash, createDecipheriv, constants, privateDecrypt } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { createGitBackupService } from "./gitBackupService.js";
import { EMPTY_BACKUP_STATE } from "./gitBackupStore.js";

const oss = {
  accessKeyId: "fixture-id",
  accessKeySecret: "fixture-secret",
  bucket: "fixture-bucket",
  region: "cn-hangzhou",
};
function credentials() {
  const data = new Map<string, string>();
  return {
    async load(key: string) {
      return data.get(key) ?? null;
    },
    async save(key: string, value: string) {
      data.set(key, value);
    },
    async delete(key: string) {
      data.delete(key);
    },
  };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "git-backup-service-test-"));
  const workspace = join(root, "workspace");
  const dataDir = join(root, "profile");
  await mkdir(join(workspace, ".git", "objects"), { recursive: true });
  await mkdir(join(workspace, ".git", "logs"), { recursive: true });
  await writeFile(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(workspace, ".git", "objects", "fixture"), Buffer.from([0, 255, 1, 0]));
  await writeFile(join(workspace, ".git", "logs", "HEAD"), "fixture reflog\n");
  return { root, workspace, dataDir };
}
async function waitFor(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await sleep(10);
  }
  throw new Error("Fixture condition timed out");
}

function decode(packed: Buffer) {
  const entries: Array<{ path: string; content: Buffer }> = [];
  let offset = 0;
  while (offset < packed.length) {
    const nameEnd = packed.indexOf(0, offset);
    const sizeEnd = packed.indexOf(0, nameEnd + 1);
    assert.ok(nameEnd >= offset && sizeEnd > nameEnd);
    const path = packed.subarray(offset, nameEnd).toString();
    const size = Number(packed.subarray(nameEnd + 1, sizeEnd).toString());
    assert.ok(Number.isSafeInteger(size) && size >= 0 && sizeEnd + 1 + size <= packed.length);
    entries.push({ path, content: packed.subarray(sizeEnd + 1, sizeEnd + 1 + size) });
    offset = sizeEnd + 1 + size;
  }
  return entries;
}

test("configuration persists redacted credentials, validates and deduplicates identity", async () => {
  const f = await fixture();
  const credentialService = credentials();
  const service = createGitBackupService(f.dataDir, { credentialService });
  try {
    assert.equal((await service.getConfig()).enabled, false);
    await assert.rejects(service.configure({ enabled: true }), /requires/);
    for (const intervalMinutes of [0, 4, 5.5, 1441, NaN])
      await assert.rejects(service.configure({ intervalMinutes }), /integer/);
    await service.configure(
      { oss, enabled: true },
      { workspacePath: f.workspace, workspaceIdentity: " id " },
    );
    await service.configure({}, { workspacePath: f.workspace, workspaceIdentity: "id" });
    const config = await service.getConfig();
    assert.equal(config.workspaces.length, 1);
    assert.equal(config.workspaces[0]!.workspaceIdentity, "id");
    assert.equal(config.oss!.accessKeySecret, "");
    assert.ok(
      !(await readFile(join(f.dataDir, "git-backup-config.json"), "utf8")).includes(
        oss.accessKeySecret,
      ),
    );
    await service.configure({ oss: { ...oss, accessKeySecret: "" } });
    await assert.rejects(
      service.configure({ oss: { ...oss, accessKeyId: "changed-id", accessKeySecret: "" } }),
      /requires a new secret/,
    );
    await service.stopBackup();
    assert.equal((await service.getConfig()).workspaces.length, 1);
    service.dispose();
    const reopened = createGitBackupService(f.dataDir, { credentialService });
    assert.equal((await reopened.getStatus()).configured, true);
    assert.equal((await reopened.getConfig()).enabled, false);
    reopened.dispose();
  } finally {
    service.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("archive decrypts and decodes v1, includes reflogs, and commits manifest last", async () => {
  const f = await fixture();
  const uploads = new Map<string, Buffer>();
  const order: string[] = [];
  const mock: typeof fetch = async (url, init) => {
    const name = new URL(String(url)).pathname.split("/").pop()!;
    order.push(name);
    uploads.set(name, Buffer.from(init!.body as Uint8Array));
    return new Response(null, { status: 200 });
  };
  const service = createGitBackupService(f.dataDir, {
    credentialService: credentials(),
    fetch: mock,
  });
  try {
    await service.configure({ oss });
    const manifest = await service.startBackup(f.workspace, "fixture-identity");
    assert.equal(order.at(-1), "manifest.json");
    const privateKey = await service.exportPrivateKey();
    const key = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      uploads.get("key.enc")!,
    );
    const cipher = createDecipheriv("aes-256-ctr", key, uploads.get("iv.bin")!);
    const restored = decode(
      Buffer.concat([cipher.update(uploads.get("data.enc")!), cipher.final()]),
    );
    assert.ok(restored.some((entry) => entry.path === join("logs", "HEAD")));
    for (const entry of restored) {
      const expected = manifest.entries.find((item) => item.path === entry.path)!;
      assert.equal(expected.size, entry.content.length);
      assert.equal(expected.sha256, createHash("sha256").update(entry.content).digest("hex"));
      assert.deepEqual(entry.content, await readFile(join(f.workspace, ".git", entry.path)));
    }
    assert.equal((await service.getStatus()).lastBackupAt, manifest.createdAt);
    assert.equal((await service.getStatus()).lastWorkspacePath, f.workspace);
  } finally {
    service.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("HTTP failure never uploads a completion manifest or records success", async () => {
  const f = await fixture();
  const order: string[] = [];
  const service = createGitBackupService(f.dataDir, {
    credentialService: credentials(),
    fetch: async (url) => {
      order.push(String(url));
      return new Response(null, { status: 403 });
    },
  });
  try {
    await service.configure({ oss });
    await assert.rejects(service.startBackup(f.workspace), /HTTP 403/);
    assert.ok(order.every((url) => !url.endsWith("manifest.json")));
    const status = await service.getStatus();
    assert.equal(status.lastBackupAt, null);
    assert.equal(status.running, false);
    assert.match(status.error!, /HTTP 403/);
  } finally {
    service.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("preflight failures persist status without creating keys or network requests", async () => {
  const f = await fixture();
  let calls = 0;
  const credentialService = credentials();
  const service = createGitBackupService(f.dataDir, {
    credentialService,
    fetch: async () => {
      calls++;
      return new Response(null, { status: 200 });
    },
  });
  try {
    await assert.rejects(service.startBackup(f.workspace), /not configured/);
    assert.match((await service.getStatus()).error!, /not configured/);
    await service.configure({ oss });
    credentialService.load = async () => null;
    await assert.rejects(service.startBackup(f.workspace), /Secret is not configured/);
    const status = await service.getStatus();
    assert.match(status.error!, /Secret is not configured/);
    assert.equal(status.running, false);
    assert.equal(status.lastBackupAt, null);
    assert.equal(calls, 0);
    await assert.rejects(readFile(join(f.dataDir, "git-backup-keys", "backup.pem")), /ENOENT/);
  } finally {
    service.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("rejected enable never mutates saved credentials and profile edits merge", async () => {
  const f = await fixture();
  const credentialService = credentials();
  let saves = 0;
  const save = credentialService.save;
  credentialService.save = async (key, value) => {
    saves++;
    await save(key, value);
  };
  const first = createGitBackupService(f.dataDir, { credentialService });
  const second = createGitBackupService(f.dataDir, { credentialService });
  try {
    await first.configure({ oss });
    const saved = saves;
    await assert.rejects(
      first.configure({ enabled: true, oss: { ...oss, accessKeySecret: "replacement-secret" } }),
      /requires/,
    );
    assert.equal(saves, saved);
    await Promise.all([
      first.configure(
        { intervalMinutes: 7 },
        { workspacePath: f.workspace, workspaceIdentity: "first" },
      ),
      second.configure({}, { workspacePath: f.workspace, workspaceIdentity: "second" }),
    ]);
    const config = await first.getConfig();
    assert.equal(config.intervalMinutes, 7);
    assert.equal(config.workspaces.length, 2);
    await first.removeWorkspace({ workspacePath: f.workspace, workspaceIdentity: "first" });
    assert.equal((await second.getConfig()).workspaces.length, 1);
  } finally {
    first.dispose();
    second.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("stale running recovers only without an active execution owner", async () => {
  const f = await fixture();
  await mkdir(f.dataDir);
  await writeFile(
    join(f.dataDir, "git-backup-state.json"),
    JSON.stringify({ ...EMPTY_BACKUP_STATE, running: true }),
  );
  let releaseFetch!: () => void;
  let uploadStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    uploadStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  const service = createGitBackupService(f.dataDir, {
    credentialService: credentials(),
    fetch: async () => {
      uploadStarted();
      await gate;
      return new Response(null, { status: 200 });
    },
  });
  try {
    const recovered = await service.getStatus();
    assert.equal(recovered.running, false);
    assert.match(recovered.error!, /interrupted/);
    await service.configure({ oss });
    const run = service.startBackup(f.workspace);
    await started;
    assert.equal((await service.getStatus()).running, true);
    await assert.rejects(service.startBackup(f.workspace), /already running/);
    await service.stopBackup();
    releaseFetch();
    await run;
    assert.equal((await service.getStatus()).running, false);
    assert.equal((await service.getConfig()).enabled, false);
  } finally {
    releaseFetch?.();
    service.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("due cycle retains a failed target after another workspace succeeds", async () => {
  const f = await fixture();
  let now = Date.now();
  const service = createGitBackupService(f.dataDir, {
    credentialService: credentials(),
    fetch: async () => new Response(null, { status: 200 }),
    now: () => now,
    schedulerPollMs: 10,
  });
  try {
    await service.configure(
      { oss, enabled: true, intervalMinutes: 5 },
      { workspacePath: join(f.root, "missing") },
    );
    await service.configure({}, { workspacePath: f.workspace });
    now += 300_001;
    await waitFor(
      async () =>
        (await service.getStatus()).lastBackupAt !== null &&
        Date.parse((await service.getStatus()).nextBackupAt!) > now,
    );
    assert.match((await service.getStatus()).error!, /1 workspace backup\(s\) failed/);
  } finally {
    service.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("stop permits the admitted run to finish but prevents the next target", async () => {
  const f = await fixture();
  let now = Date.now();
  let releaseFetch!: () => void;
  let uploadStarted!: () => void;
  let dataUploads = 0;
  const started = new Promise<void>((resolve) => {
    uploadStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  const service = createGitBackupService(f.dataDir, {
    credentialService: credentials(),
    now: () => now,
    schedulerPollMs: 10,
    fetch: async (url) => {
      if (String(url).endsWith("data.enc")) dataUploads++;
      uploadStarted();
      await gate;
      return new Response(null, { status: 200 });
    },
  });
  try {
    await service.configure(
      { oss, enabled: true, intervalMinutes: 5 },
      { workspacePath: f.workspace, workspaceIdentity: "first" },
    );
    await service.configure({}, { workspacePath: f.workspace, workspaceIdentity: "second" });
    now += 300_001;
    await started;
    await service.stopBackup();
    releaseFetch();
    await waitFor(
      async () =>
        (await service.getStatus()).lastBackupAt !== null && !(await service.getStatus()).running,
    );
    await sleep(40);
    assert.equal(dataUploads, 1);
    assert.equal((await service.getStatus()).nextBackupAt, null);
  } finally {
    releaseFetch?.();
    service.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("two host instances admit only one due cycle and dispose preserves enabled", async () => {
  const f = await fixture();
  let now = Date.now();
  const credentialService = credentials();
  let dataUploads = 0;
  const mock: typeof fetch = async (url) => {
    if (String(url).endsWith("data.enc")) dataUploads++;
    return new Response(null, { status: 200 });
  };
  const options = { credentialService, fetch: mock, now: () => now, schedulerPollMs: 10 };
  const first = createGitBackupService(f.dataDir, options);
  const second = createGitBackupService(f.dataDir, options);
  try {
    await first.configure(
      { oss, enabled: true, intervalMinutes: 5 },
      { workspacePath: f.workspace },
    );
    now += 300_001;
    await waitFor(async () => (await first.getStatus()).lastBackupAt !== null);
    await sleep(80);
    assert.equal(dataUploads, 1);
    assert.ok(Date.parse((await first.getStatus()).nextBackupAt!) > now);
    first.dispose();
    second.dispose();
    assert.equal((await first.getConfig()).enabled, true);
    await first.stopBackup();
    now += 300_001;
    await sleep(30);
    assert.equal(dataUploads, 1);
  } finally {
    first.dispose();
    second.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});
