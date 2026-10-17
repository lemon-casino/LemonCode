import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { dirname, resolve } from "node:path";
import { STARTUP_MEDIA_FILES, STARTUP_MEDIA_NOTICE_FILES } from "./startup-media-assets.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
if (args.length > 1 || args.some((arg) => arg.startsWith("--")))
  throw new Error("Usage: node import-startup-media.mjs [startup.mp4]");
const source = resolve(
  args[0] ??
    resolve(
      desktopRoot,
      "../../../baili-codex/skills/codex-white-dragon-animation/assets/runtime/startup.mp4",
    ),
);
const destination = resolve(desktopRoot, "assets/startup-media");
async function hash(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}
const notice = (await readFile(resolve(dirname(source), "ASSET-NOTICE.md"), "utf8")).replace(
  /\r\n/g,
  "\n",
);
await mkdir(destination, { recursive: true });
const files = [
  [source, "baili.mp4"],
  [resolve(dirname(source), "wallpaper.mp4"), "baili-wallpaper.mp4"],
];
const manifestPath = resolve(destination, "manifest.json");
for (const [input, name] of files) {
  const temporary = resolve(destination, `${randomUUID()}.mp4`);
  await copyFile(input, temporary);
  const sha256 = await hash(input);
  if (sha256 !== (await hash(temporary))) throw new Error("Local animation copy checksum mismatch");
  await rename(temporary, resolve(destination, name));
}
await writeFile(resolve(destination, "baili-NOTICE.md"), notice, "utf8");
// 更新白璃时也保留并校验其它模板资源，不能重置整个媒体清单。
const hashes = Object.fromEntries(
  await Promise.all(
    [...STARTUP_MEDIA_FILES, ...STARTUP_MEDIA_NOTICE_FILES].map(async (name) => [
      name,
      await hash(resolve(destination, name)),
    ]),
  ),
);
await writeFile(manifestPath, JSON.stringify({ version: 1, files: hashes }, null, 2) + "\n");
console.log(
  "Bundled media updated. Review the media, notices and manifest together; normal desktop builds include them automatically.",
);
