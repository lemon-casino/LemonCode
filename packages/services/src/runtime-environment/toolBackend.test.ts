import assert from "node:assert/strict";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  downloadAndPublishBackend,
  extractBackendArchive,
  MISE_ASSETS,
  MISE_BACKEND_VERSION,
  MISE_ASSET_DIGESTS,
  validateBundledBackend,
} from "./adapters/backendArchive.js";
import { createToolBackend } from "./adapters/toolBackend.js";
import { WINDOWS_X64, withTempDir } from "./toolBackend.fixture.js";

const OFFICIAL_ARCHIVE = process.env.LCODE_MISE_FIXTURE_ARCHIVE;

async function officialArchiveOrSkip(t: { skip: (reason?: string) => void }): Promise<Buffer | undefined> {
  if (!OFFICIAL_ARCHIVE) {
    t.skip("set LCODE_MISE_FIXTURE_ARCHIVE to a fixed official Windows x64 archive");
    return undefined;
  }
  try {
    return await readFile(OFFICIAL_ARCHIVE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    t.skip(`official mise fixture is unavailable: ${OFFICIAL_ARCHIVE}`);
    return undefined;
  }
}

function responseFor(bytes: Buffer): Response {
  return new Response(bytes, {
    status: 200,
    headers: { "content-length": String(bytes.byteLength) },
  });
}

function maliciousZipWithTraversal(): Buffer {
  const name = Buffer.from("mise/../outside.txt", "utf8");
  const content = Buffer.from("escape", "utf8");
  const local = Buffer.alloc(30 + name.length + content.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  name.copy(local, 30);
  content.copy(local, 30 + name.length);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(0, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);
  name.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
}

test("parallel first publish validates the fixed archive once and a real Windows backend", async (t) => {
  const archive = await officialArchiveOrSkip(t);
  if (!archive) return;
  await withTempDir(async (root) => {
    const destinationRoot = join(root, "data with spaces", "运行环境");
    let fetchCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      fetchCalls += 1;
      return responseFor(archive);
    };
    const options = { platform: WINDOWS_X64, destinationRoot, fetch: fetchImpl };
    const [first, second] = await Promise.all([
      downloadAndPublishBackend(options),
      downloadAndPublishBackend(options),
    ]);
    assert.equal(fetchCalls, 1);
    assert.equal(first, second);
    assert.match(first, /data with spaces[\\/]运行环境[\\/]v2026\.10\.2[\\/]windows-x64[\\/]bin[\\/]mise\.exe/u);
    const bundledRoot = join(destinationRoot, MISE_BACKEND_VERSION, "windows-x64");
    const validated = await validateBundledBackend(bundledRoot, {
      platform: WINDOWS_X64,
      archiveSha256: MISE_ASSET_DIGESTS["windows-x64"],
    });
    assert.equal(validated.backendPath, first);
    if (process.platform !== "win32" || process.arch !== "x64") return;
    const backend = createToolBackend({ dataDir: join(root, "runtime data"), backendPath: first, platform: WINDOWS_X64 });
    assert.equal(await backend.ensureBackend(), first);
    assert.deepEqual(await backend.probeBackend(), { available: true });
    assert.equal(await backend.resolveVersion({ key: "node", constraint: "24.14.0" }), "24.14.0");
  });
});

test("corrupt fixed archive digest never publishes a backend directory", async (t) => {
  const archive = await officialArchiveOrSkip(t);
  if (!archive) return;
  await withTempDir(async (root) => {
    const corrupt = Buffer.from(archive);
    corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] ?? 0) ^ 0xff;
    const destinationRoot = join(root, "带空格 的数据");
    const fetchImpl: typeof fetch = async () => responseFor(corrupt);
    await assert.rejects(
      downloadAndPublishBackend({ platform: WINDOWS_X64, destinationRoot, fetch: fetchImpl }),
      /digest mismatch/u,
    );
    await assert.rejects(stat(join(destinationRoot, MISE_BACKEND_VERSION, "windows-x64")), { code: "ENOENT" });
  });
});

test("archive traversal and unexpected members are rejected before extraction", async () => {
  await withTempDir(async (root) => {
    const archivePath = join(root, "恶意 archive.zip");
    await writeFile(archivePath, maliciousZipWithTraversal());
    await assert.rejects(
      extractBackendArchive(archivePath, join(root, "output"), WINDOWS_X64, MISE_ASSETS["windows-x64"]),
      /traverses directories|unexpected member/u,
    );
    await assert.rejects(access(join(root, "outside.txt")));
  });
});

test("offline ENOTFOUND is surfaced and leaves no published backend", async () => {
  await withTempDir(async (root) => {
    const destinationRoot = join(root, "离线 data");
    const fetchImpl: typeof fetch = async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND github.com"), { code: "ENOTFOUND" });
    };
    await assert.rejects(
      downloadAndPublishBackend({ platform: WINDOWS_X64, destinationRoot, fetch: fetchImpl }),
      /ENOTFOUND/u,
    );
    await assert.rejects(stat(join(destinationRoot, MISE_BACKEND_VERSION, "windows-x64")), { code: "ENOENT" });
  });
});

test("tool input is allowlisted and exact semver is mandatory", async () => {
  await withTempDir(async (root) => {
    const backend = createToolBackend({ dataDir: root });
    await assert.rejects(backend.installTool({ key: "curl", version: "1.0.0" }), /unsupported managed tool/u);
    await assert.rejects(backend.installTool({ key: "node", version: "../24.14.0" }), /exact semver/u);
  });
});

test("missing bundled mise does not download it or fall back to PATH", async () => {
  await withTempDir(async (root) => {
    let fetchCalls = 0;
    const backend = createToolBackend({ dataDir: root, fetch: async () => { fetchCalls++; throw new Error("must not fetch"); } });
    await assert.rejects(backend.ensureBackend(), /runtime download is disabled/u);
    assert.equal((await backend.probeBackend()).available, false);
    assert.equal(fetchCalls, 0);
  });
});
