import assert from "node:assert/strict";
import { test } from "node:test";
import { unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startupMediaPlugin } from "./startupMediaPlugin.js";
import { createStartupMediaFixture } from "./startup-media-test-fixture.js";

for (const command of ["serve", "build"] as const) {
  test(`默认 ${command} 包含全部内置媒体和来源声明，无环境变量或开关`, async () => {
    const { root, directory } = await createStartupMediaFixture();
    await writeFile(resolve(directory, "unrelated.mp4"), "not allowed");
    const plugin = startupMediaPlugin(root);
    const config = await (plugin.config as Function)({}, { command });
    assert.deepEqual(JSON.parse(config.define.__LCODE_STARTUP_MEDIA_FILES__), [
      "baili.mp4",
      "baili-wallpaper.mp4",
      "aemeath-artwork.jpg",
      "aemeath-closed-eyes.png",
      "aemeath-contours.json",
    ]);
    const emitted: string[] = [];
    await (plugin.generateBundle as Function).call({
      emitFile: (file: { fileName: string }) => emitted.push(file.fileName),
    });
    assert.deepEqual(
      emitted.sort(),
      [
        "baili.mp4",
        "baili-wallpaper.mp4",
        "aemeath-artwork.jpg",
        "aemeath-closed-eyes.png",
        "aemeath-contours.json",
        "baili-NOTICE.md",
        "aemeath-NOTICE.md",
        "manifest.json",
      ]
        .map((name) => `startup-media/${name}`)
        .sort(),
    );
  });
}

test("素材缺失或哈希错误直接拒绝构建，不能生成空可用清单", async () => {
  const { root, directory } = await createStartupMediaFixture();
  await unlink(resolve(directory, "baili.mp4"));
  await assert.rejects(
    (startupMediaPlugin(root).config as Function)({}, { command: "build" }),
    /baili.mp4/,
  );
  await writeFile(resolve(directory, "baili.mp4"), "corrupted");
  await assert.rejects(
    (startupMediaPlugin(root).config as Function)({}, { command: "build" }),
    /baili.mp4/,
  );
  await writeFile(resolve(directory, "manifest.json"), "null");
  await assert.rejects(
    (startupMediaPlugin(root).config as Function)({}, { command: "build" }),
    /manifest/,
  );
});
