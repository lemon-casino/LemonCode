import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { readReleaseVerifiedNotices, readVerifiedNotices } from "./third-party-notices.mjs";
import {
  seaUploadBinaryNames,
  uploadSeaBinaries,
} from "../apps/lcode-cli/packages/cli/scripts/upload-sea-smb.mjs";

const run = promisify(execFile);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const materialCount = 20;
const version = "1.2.3";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "lcode-material-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "third-party"));
  const bytes = Buffer.from("Preserved third-party notices\n");
  const reviewRequired = Array.from({ length: materialCount }, (_, i) => ({
    id: `fixture-${i}@1.0.0`,
    reason: "Original material unavailable",
  }));
  const manifest = {
    schemaVersion: 1,
    noticesSha256: hash(bytes),
    inputs: { "source.txt": hash("source\n") },
    reviewRequired,
  };
  const saveManifest = () =>
    writeFile(join(root, "third-party/inventory.json"), JSON.stringify(manifest));
  const saveBaseline = (items = reviewRequired, schemaVersion = 1) =>
    writeFile(
      join(root, "third-party/release-review-baseline.json"),
      JSON.stringify({ schemaVersion, reviewRequired: items }),
    );
  await writeFile(join(root, "THIRD-PARTY-NOTICES.md"), bytes);
  await writeFile(join(root, "source.txt"), "source\r\n");
  await saveManifest();
  await saveBaseline();
  const distDir = join(root, "dist");
  await mkdir(distDir);
  for (const name of seaUploadBinaryNames()) await writeFile(join(distDir, name), name);
  const options = {
    rootDirectory: join(root, "apps/lcode-cli"),
    destinationRoot: join(root, "local-upload"),
    distDir,
    version,
    force: true,
  };
  return { root, bytes, manifest, saveManifest, saveBaseline, options };
}

test("20 retained material gaps permit notice verification and SEA publication", async (t) => {
  const { root, bytes, manifest, options } = await fixture(t);
  assert.deepEqual(await readVerifiedNotices(root), bytes);
  assert.deepEqual(await readReleaseVerifiedNotices(root), bytes);
  const result = await uploadSeaBinaries(options);
  assert.equal(result.status, "uploaded");
  assert.equal(result.files.length, seaUploadBinaryNames().length);
  for (const name of seaUploadBinaryNames())
    assert.equal(await readFile(join(result.destination, name), "utf8"), name);
  assert.equal(
    JSON.parse(await readFile(join(root, "third-party/inventory.json"), "utf8")).reviewRequired
      .length,
    manifest.reviewRequired.length,
  );
});

for (const [name, corrupt, expected] of [
  [
    "changed notice bytes",
    async ({ root }) => writeFile(join(root, "THIRD-PARTY-NOTICES.md"), "tampered"),
    /notices changed/u,
  ],
  [
    "stale source inputs",
    async ({ root }) => writeFile(join(root, "source.txt"), "new source\n"),
    /input changed/u,
  ],
  [
    "unsupported inventory schema",
    async (f) => {
      f.manifest.schemaVersion = 99;
      await f.saveManifest();
    },
    /Unsupported third-party inventory/u,
  ],
  [
    "missing material inventory",
    async (f) => {
      delete f.manifest.reviewRequired;
      await f.saveManifest();
    },
    /Missing material review inventory/u,
  ],
  [
    "invalid material inventory",
    async (f) => {
      f.manifest.reviewRequired = {};
      await f.saveManifest();
    },
    /Missing material review inventory/u,
  ],
]) {
  test(`${name} still blocks checks and force upload before destination writes`, async (t) => {
    const f = await fixture(t);
    await corrupt(f);
    await assert.rejects(readVerifiedNotices(f.root), expected);
    await assert.rejects(uploadSeaBinaries(f.options), expected);
    await assert.rejects(access(f.options.destinationRoot), { code: "ENOENT" });
  });
}

for (const [name, change] of [
  ["new gap", (items) => [...items, { id: "new@1.0.0", reason: "new gap" }]],
  ["removed gap", (items) => items.slice(1)],
  ["changed reason", (items) => items.map((item) => ({ ...item, reason: "changed" }))],
  ["duplicate gap", (items) => [...items, items[0]]],
  ["invalid entry", (items) => [...items, { id: "", reason: "invalid" }]],
]) {
  test(`release baseline rejects ${name} before force upload writes`, async (t) => {
    const f = await fixture(t);
    await f.saveBaseline(change(f.manifest.reviewRequired));
    await assert.rejects(uploadSeaBinaries(f.options), /baseline/iu);
    await assert.rejects(access(f.options.destinationRoot), { code: "ENOENT" });
  });
}

test("release still validates the baseline schema and all target files", async (t) => {
  const f = await fixture(t);
  await f.saveBaseline(f.manifest.reviewRequired, 99);
  await assert.rejects(uploadSeaBinaries(f.options), /Unsupported release review baseline/u);
  await f.saveBaseline();
  await rm(join(f.options.distDir, seaUploadBinaryNames()[0]));
  await assert.rejects(uploadSeaBinaries(f.options), /Missing SEA binaries/u);
  await assert.rejects(access(f.options.destinationRoot), { code: "ENOENT" });
});

test("failed checks preserve an existing release even with force", async (t) => {
  const f = await fixture(t);
  const target = join(f.options.destinationRoot, `lcode-cli-${version}`);
  await mkdir(target, { recursive: true });
  const marker = join(target, "existing-release.txt");
  await writeFile(marker, "keep this release");
  await writeFile(join(f.root, "source.txt"), "changed source");
  await assert.rejects(uploadSeaBinaries(f.options), /input changed/u);
  assert.equal(await readFile(marker, "utf8"), "keep this release");
});

test("legacy --strict runs normal checks and reports retained material gaps", async () => {
  const { stdout, stderr } = await run(
    process.execPath,
    ["scripts/licenses.mjs", "check", "--strict"],
    {
      cwd: resolve(import.meta.dirname, ".."),
      maxBuffer: 1024 * 1024,
    },
  );
  assert.match(stdout, /许可标识与声明新鲜度检查通过/u);
  assert.match(stderr, /--strict 已停用/u);
  assert.match(stderr, /材料缺口仅作记录/u);
  assert.doesNotMatch(stdout, /许可完整/u);
});
