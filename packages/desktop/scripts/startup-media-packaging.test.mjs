import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createPackage } from "@electron/asar";
import {
  assertStartupMediaPackaging,
  assertPackagedStartupMedia,
} from "./startup-media-packaging.mjs";
import { createStartupMediaFixture } from "./startup-media-test-fixture.ts";

test("默认打包要求完整输出，缺文件、空文件或旧输出均拒绝", async () => {
  const { root, directory } = await createStartupMediaFixture();
  await assert.rejects(assertStartupMediaPackaging(root), /startup|media/i);
  const output = resolve(root, "out/renderer/startup-media");
  await cp(directory, output, { recursive: true });
  await assertStartupMediaPackaging(root);
  await unlink(resolve(output, "baili.mp4"));
  await assert.rejects(assertStartupMediaPackaging(root), /baili.mp4/);
  await writeFile(resolve(output, "baili.mp4"), "");
  await assert.rejects(assertStartupMediaPackaging(root), /baili.mp4/);
  const old = Buffer.from("old-but-internally-consistent");
  await writeFile(resolve(output, "baili.mp4"), old);
  const manifest = JSON.parse(await readFile(resolve(output, "manifest.json"), "utf8"));
  manifest.files["baili.mp4"] = createHash("sha256").update(old).digest("hex");
  await writeFile(resolve(output, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(assertStartupMediaPackaging(root), /differs from repository/);
});

test("实际 ASAR 必须含完整媒体与声明，字节与仓库素材一致", async () => {
  const { root, directory } = await createStartupMediaFixture();
  const stage = resolve(root, "stage");
  const media = resolve(stage, "out/renderer/startup-media");
  await cp(directory, media, { recursive: true });
  const good = resolve(root, "good.asar");
  await createPackage(stage, good);
  await assertPackagedStartupMedia(root, good);
  await writeFile(resolve(media, "baili.mp4"), "corrupted");
  const bad = resolve(root, "bad.asar");
  await createPackage(stage, bad);
  await assert.rejects(assertPackagedStartupMedia(root, bad), /baili.mp4/);
  const empty = resolve(root, "empty");
  await mkdir(empty);
  await writeFile(resolve(empty, "package.json"), "{}");
  const missing = resolve(root, "missing.asar");
  await createPackage(empty, missing);
  await assert.rejects(assertPackagedStartupMedia(root, missing), /startup-media/);
});

test("已删除素材不能随旧输出或实际 ASAR 重新进入安装包", async () => {
  const { root, directory } = await createStartupMediaFixture();
  const stage = resolve(root, "stage");
  const renderer = resolve(stage, "out/renderer");
  await cp(directory, resolve(renderer, "startup-media"), { recursive: true });
  await writeFile(resolve(renderer, "startup-media/dragon.mp4"), "removed");
  await assert.rejects(assertStartupMediaPackaging(root, renderer), /Unexpected startup media/);
  const archive = resolve(root, "stale.asar");
  await createPackage(stage, archive);
  await assert.rejects(assertPackagedStartupMedia(root, archive), /Unexpected startup media/);
});
