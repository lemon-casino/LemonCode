import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  downloadVerifiedMacDmg,
  selectVerifiedMacDmgArtifact,
  type MacUpdateFetch,
} from "./verifiedMacUpdate.js";

function sha512(value: Uint8Array | string): string {
  return createHash("sha512").update(value).digest("base64");
}

test("macOS 只选择当前清单中的 DMG，并用清单基址解析相对 URL", () => {
  const dmg = Buffer.from("unsigned dmg bytes");
  const selected = selectVerifiedMacDmgArtifact({
    files: [
      { url: "LCode-4.0.0-mac-arm64.zip", sha512: sha512("zip") },
      { url: "downloads/LCode-4.0.0-mac-arm64.dmg", sha512: sha512(dmg), size: dmg.length },
    ],
    lcodeManifestBaseUrl: "https://code.lemon.vin/releases/",
  });

  assert.deepEqual(selected, {
    url: "https://code.lemon.vin/releases/downloads/LCode-4.0.0-mac-arm64.dmg",
    fileName: "LCode-4.0.0-mac-arm64.dmg",
    sha512: sha512(dmg),
    size: dmg.length,
  });
});

test("macOS 清单缺 DMG、缺 SHA-512 或摘要非法时 fail-closed", () => {
  assert.throws(
    () =>
      selectVerifiedMacDmgArtifact({
        files: [{ url: "https://example.test/LCode.zip", sha512: sha512("zip") }],
      }),
    /DMG/iu,
  );
  assert.throws(
    () =>
      selectVerifiedMacDmgArtifact({
        files: [{ url: "https://example.test/LCode.dmg" }],
      }),
    /SHA-512/iu,
  );
  assert.throws(
    () =>
      selectVerifiedMacDmgArtifact({
        files: [{ url: "https://example.test/LCode.dmg", sha512: "not-base64" }],
      }),
    /SHA-512/iu,
  );
});

test("macOS DMG 下载完成后校验 size/SHA-512 并原子落盘", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-mac-update-"));
  const bytes = Buffer.from("verified unsigned macOS installer");
  const progress: Array<[number, number | null]> = [];
  const fetcher: MacUpdateFetch = async () => new Response(bytes);
  try {
    const path = await downloadVerifiedMacDmg({
      artifact: {
        url: "https://code.lemon.vin/api/v1/releases/download/LCode-4.0.0-mac-arm64.dmg",
        fileName: "LCode-4.0.0-mac-arm64.dmg",
        sha512: sha512(bytes),
        size: bytes.length,
      },
      directory,
      fetcher,
      onProgress: (transferred, total) => progress.push([transferred, total]),
    });

    assert.equal(path, join(directory, "LCode-4.0.0-mac-arm64.dmg"));
    assert.deepEqual(await readFile(path), bytes);
    assert.deepEqual(progress.at(-1), [bytes.length, bytes.length]);
    assert.deepEqual(await readdir(directory), ["LCode-4.0.0-mac-arm64.dmg"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("macOS DMG 摘要不匹配时删除临时文件且不产生 ready 安装包", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-mac-update-invalid-"));
  const fetcher: MacUpdateFetch = async () => new Response("tampered");
  try {
    await assert.rejects(
      downloadVerifiedMacDmg({
        artifact: {
          url: "https://code.lemon.vin/LCode-4.0.0-mac-x64.dmg",
          fileName: "LCode-4.0.0-mac-x64.dmg",
          sha512: sha512("expected"),
          size: Buffer.byteLength("tampered"),
        },
        directory,
        fetcher,
      }),
      /SHA-512/iu,
    );
    assert.deepEqual(await readdir(directory), []);

    await assert.rejects(
      downloadVerifiedMacDmg({
        artifact: {
          url: "https://code.lemon.vin/LCode-4.0.0-mac-x64.dmg",
          fileName: "LCode-4.0.0-mac-x64.dmg",
          sha512: sha512("tampered"),
          size: 3,
        },
        directory,
        fetcher,
      }),
      /size mismatch/iu,
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("macOS DMG 下载取消后清理 partial 文件", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-mac-update-cancelled-"));
  const bytes = Buffer.from("cancel after first chunk");
  const abortController = new AbortController();
  const fetcher: MacUpdateFetch = async () => new Response(bytes);
  try {
    await assert.rejects(
      downloadVerifiedMacDmg({
        artifact: {
          url: "https://code.lemon.vin/LCode-4.0.0-mac-arm64.dmg",
          fileName: "LCode-4.0.0-mac-arm64.dmg",
          sha512: sha512(bytes),
          size: bytes.length,
        },
        directory,
        fetcher,
        signal: abortController.signal,
        onProgress: () => abortController.abort(),
      }),
      /cancelled/iu,
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
