import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { STARTUP_MEDIA_FILES, STARTUP_MEDIA_NOTICE_FILES } from "./startup-media-assets.mjs";

export async function createStartupMediaFixture() {
  const parent = resolve(import.meta.dirname, "../.e2e-artifacts/startup-animation");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, "bundled-media-"));
  const directory = resolve(root, "assets/startup-media");
  await mkdir(directory, { recursive: true });
  const files: Record<string, string> = {};
  for (const name of [...STARTUP_MEDIA_FILES, ...STARTUP_MEDIA_NOTICE_FILES]) {
    const data = Buffer.from(`fixture ${name}`);
    await writeFile(resolve(directory, name), data);
    files[name] = createHash("sha256").update(data).digest("hex");
  }
  await writeFile(resolve(directory, "manifest.json"), JSON.stringify({ version: 1, files }));
  return { root, directory };
}
