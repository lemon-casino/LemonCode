import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  downloadVerifiedUpdateArtifact,
  resolveUpdateInstallExtensions,
  selectVerifiedUpdateArtifact,
  type UpdateArtifactFetch,
} from "./verifiedUpdateArtifact.js";

function sha512(value: Uint8Array | string): string {
  return createHash("sha512").update(value).digest("base64");
}

test("三平台安装格式映射由同一纯函数决定", () => {
  assert.deepEqual(resolveUpdateInstallExtensions("win32", null), [".exe"]);
  assert.deepEqual(resolveUpdateInstallExtensions("darwin", null), [".dmg"]);
  assert.deepEqual(resolveUpdateInstallExtensions("linux", [".appimage"]), [".appimage"]);
  assert.deepEqual(resolveUpdateInstallExtensions("linux", [".deb"]), [".deb"]);
  assert.throws(() => resolveUpdateInstallExtensions("linux", null), /unsupported/iu);
});

test("三平台按当前安装类型选择同架构文件并解析 Worker 相对 URL", () => {
  const cases: Array<[string, string, string]> = [
    ["windows", ".exe", "LCode-4.0.0-win-x64.exe"],
    ["macOS", ".dmg", "LCode-4.0.0-mac-arm64.dmg"],
    ["Linux AppImage", ".AppImage", "LCode-4.0.0-linux-x86_64.AppImage"],
    ["Linux DEB", ".deb", "LCode-4.0.0-linux-amd64.deb"],
    ["Linux RPM", ".rpm", "LCode-4.0.0-linux-aarch64.rpm"],
    ["Linux Pacman", ".pkg.tar.zst", "LCode-4.0.0-linux-aarch64.pkg.tar.zst"],
  ];

  for (const [label, extension, fileName] of cases) {
    const bytes = Buffer.from(`${label} unsigned package`);
    const selected = selectVerifiedUpdateArtifact({
      files: [
        { url: "LCode-4.0.0-other.zip", sha512: sha512("zip"), size: 3 },
        { url: `downloads/${fileName}`, sha512: sha512(bytes), size: bytes.length },
      ],
      lcodeManifestBaseUrl: "https://code.lemon.vin/releases/",
      lcodeInstallExtensions: [extension],
    });

    assert.deepEqual(selected, {
      url: `https://code.lemon.vin/releases/downloads/${fileName}`,
      fileName,
      sha512: sha512(bytes),
      size: bytes.length,
    });
  }
});

test("错安装格式、缺 size/SHA-512 或非法字段统一 fail-closed", () => {
  assert.throws(
    () =>
      selectVerifiedUpdateArtifact({
        files: [{ url: "https://example.test/LCode.dmg", sha512: sha512("dmg"), size: 3 }],
        lcodeInstallExtensions: [".exe"],
      }),
    /install format/iu,
  );
  assert.throws(
    () =>
      selectVerifiedUpdateArtifact({
        files: [{ url: "https://example.test/LCode.exe", sha512: sha512("exe") }],
        lcodeInstallExtensions: [".exe"],
      }),
    /size/iu,
  );
  assert.throws(
    () =>
      selectVerifiedUpdateArtifact({
        files: [{ url: "https://example.test/LCode.exe", size: 3 }],
        lcodeInstallExtensions: [".exe"],
      }),
    /SHA-512/iu,
  );
  assert.throws(
    () =>
      selectVerifiedUpdateArtifact({
        files: [{ url: "https://example.test/LCode.exe", sha512: "not-base64", size: 3 }],
        lcodeInstallExtensions: [".exe"],
      }),
    /SHA-512/iu,
  );
});

test("安装包下载完成后校验 size/SHA-512 并原子落盘", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-update-artifact-"));
  const bytes = Buffer.from("verified unsigned installer");
  const progress: Array<[number, number]> = [];
  const fetcher: UpdateArtifactFetch = async () => new Response(bytes);
  try {
    const path = await downloadVerifiedUpdateArtifact({
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

test("安装包摘要或大小不匹配时删除临时文件", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-update-artifact-invalid-"));
  const fetcher: UpdateArtifactFetch = async () => new Response("tampered");
  try {
    await assert.rejects(
      downloadVerifiedUpdateArtifact({
        artifact: {
          url: "https://code.lemon.vin/LCode-4.0.0-win-x64.exe",
          fileName: "LCode-4.0.0-win-x64.exe",
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
      downloadVerifiedUpdateArtifact({
        artifact: {
          url: "https://code.lemon.vin/LCode-4.0.0-linux-x86_64.AppImage",
          fileName: "LCode-4.0.0-linux-x86_64.AppImage",
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

test("安装包下载取消后清理 partial 文件", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-update-artifact-cancelled-"));
  const bytes = Buffer.from("cancel after first chunk");
  const abortController = new AbortController();
  const fetcher: UpdateArtifactFetch = async () => new Response(bytes);
  try {
    await assert.rejects(
      downloadVerifiedUpdateArtifact({
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
