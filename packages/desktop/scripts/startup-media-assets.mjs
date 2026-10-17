import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const STARTUP_MEDIA_FILES = [
  "baili.mp4",
  "baili-wallpaper.mp4",
  "aemeath-artwork.jpg",
  "aemeath-closed-eyes.png",
  "aemeath-contours.json",
];
export const STARTUP_MEDIA_NOTICE_FILES = ["baili-NOTICE.md", "aemeath-NOTICE.md"];
export const startupMediaDirectory = (desktopRoot) => resolve(desktopRoot, "assets/startup-media");

/** 仓库资源是唯一来源；缺失不能退化为空清单，否则安装后所有内置选项都会置灰。 */
export async function readStartupMediaAssets(directory) {
  const manifest = await readFile(resolve(directory, "manifest.json"));
  const parsed = JSON.parse(manifest.toString("utf8"));
  const names = [...STARTUP_MEDIA_FILES, ...STARTUP_MEDIA_NOTICE_FILES];
  if (
    !parsed ||
    parsed.version !== 1 ||
    !parsed.files ||
    Object.keys(parsed.files).sort().join() !== [...names].sort().join()
  )
    throw new Error(`Invalid bundled startup media manifest: ${directory}`);
  const entries = await Promise.all(
    names.map(async (name) => {
      const data = await readFile(resolve(directory, name));
      const hash = createHash("sha256").update(data).digest("hex");
      if (!data.length || hash !== parsed.files[name])
        throw new Error(`Bundled startup media checksum mismatch: ${name}`);
      return [name, data];
    }),
  );
  return Object.fromEntries([...entries, ["manifest.json", manifest]]);
}
