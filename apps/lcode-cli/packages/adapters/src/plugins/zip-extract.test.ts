import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extractZipArchive } from "./zip-extract.js";

// 最小无压缩 ZIP fixture；只有测试数据，不执行下载、代码生成或真实插件安装。
function zipEntry(name: string, content: string, unixMode = 0o100644, flags = 0): Buffer {
  const fileName = Buffer.from(name);
  const contentBytes = Buffer.from(content);
  const bytes = flags & 1 ? Buffer.concat([Buffer.alloc(12), contentBytes]) : contentBytes;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(flags, 6);
  local.writeUInt32LE(bytes.length, 18);
  local.writeUInt32LE(contentBytes.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50, 0);
  directory.writeUInt16LE(0x0314, 4);
  directory.writeUInt16LE(20, 6);
  directory.writeUInt16LE(flags, 8);
  directory.writeUInt32LE(bytes.length, 20);
  directory.writeUInt32LE(contentBytes.length, 24);
  directory.writeUInt16LE(fileName.length, 28);
  directory.writeUInt32LE((unixMode << 16) >>> 0, 38);
  const centralOffset = local.length + fileName.length + bytes.length;
  const centralSize = directory.length + fileName.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, fileName, bytes, directory, fileName, end]);
}

async function fixture(
  archive: Buffer,
  run: (archivePath: string, targetRoot: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "lcode-zip-extract-test-"));
  try {
    const archivePath = join(root, "fixture.zip");
    await writeFile(archivePath, archive);
    await run(archivePath, join(root, "extract"));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("ZIP extraction preserves the root snapshot and file content", async () => {
  await fixture(
    zipEntry("demo/.lcode-plugin/plugin.json", '{"name":"demo"}'),
    async (archivePath, targetRoot) => {
      const result = await extractZipArchive({ archivePath, targetRoot });
      assert.deepEqual(Array.from(result.topLevelSegments), ["demo"]);
      assert.equal(
        await readFile(join(targetRoot, "demo", ".lcode-plugin", "plugin.json"), "utf8"),
        '{"name":"demo"}',
      );
    },
  );
});

for (const [name, mode, flags, expected] of [
  ["../escape", 0o100644, 0, /invalid relative path|Unsafe plugin zip path/],
  ["demo/link", 0o120777, 0, /symlinks are not supported/],
  ["demo/secret", 0o100644, 1, /Encrypted plugin zip entries are not supported/],
] as const) {
  test(`ZIP extraction rejects unsafe entry ${name}`, async () => {
    await fixture(zipEntry(name, "fixture", mode, flags), async (archivePath, targetRoot) => {
      await assert.rejects(extractZipArchive({ archivePath, targetRoot }), expected);
    });
  });
}

test("ZIP extraction observes cancellation before writing entries", async () => {
  await fixture(zipEntry("demo/file", "fixture"), async (archivePath, targetRoot) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      extractZipArchive({ archivePath, targetRoot, signal: controller.signal }),
      { name: "AbortError" },
    );
  });
});
