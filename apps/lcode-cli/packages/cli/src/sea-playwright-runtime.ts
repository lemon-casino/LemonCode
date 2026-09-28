import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join, normalize, sep } from "node:path";
import type { PlaywrightChromiumModule } from "@lcode/adapters/browser";

declare const __CLI_VERSION__: string;

type SeaModule = typeof import("node:sea");

interface SeaPlaywrightFile {
  mode: number;
  path: string;
  sha256: string;
}

interface SeaPlaywrightManifest {
  files: SeaPlaywrightFile[];
  hash: string;
  packageVersion: string;
  target: string;
  version: 1;
}

const ASSET_PREFIX = "lcode-playwright-runtime/";
const MANIFEST_ASSET_KEY = `${ASSET_PREFIX}manifest.json`;
const MARKER_FILE = "playwright-manifest.json";
const PACKAGE_JSON_PATH = "node_modules/playwright-core/package.json";

export async function loadCliPlaywrightChromium(): Promise<PlaywrightChromiumModule> {
  const sea = await import("node:sea");
  if (!sea.isSea()) {
    return (await import("playwright-core")) as PlaywrightChromiumModule;
  }

  const runtimeDirectory = await ensureSeaPlaywrightRuntime(sea);
  const require = createRequire(join(runtimeDirectory, "lcode-playwright-loader.cjs"));
  return require("playwright-core") as PlaywrightChromiumModule;
}

async function ensureSeaPlaywrightRuntime(sea: SeaModule): Promise<string> {
  const manifest = readManifest(sea);
  const cacheDirectory = join(
    cacheBaseDirectory(),
    __CLI_VERSION__,
    manifest.target,
    `playwright-${manifest.packageVersion}-${manifest.hash}`,
  );
  const markerPath = join(cacheDirectory, MARKER_FILE);
  if (await isCacheCurrent(markerPath, manifest)) return cacheDirectory;

  const temporaryDirectory = `${cacheDirectory}.tmp-${process.pid}-${Date.now()}`;
  await rm(temporaryDirectory, { force: true, recursive: true });
  await mkdir(temporaryDirectory, { recursive: true });

  for (const file of manifest.files) {
    assertSafeRuntimePath(file.path);
    const bytes = Buffer.from(sea.getRawAsset(`${ASSET_PREFIX}${file.path}`));
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== file.sha256) {
      throw new Error(`SEA Playwright asset hash mismatch for ${file.path}`);
    }
    const outputPath = join(temporaryDirectory, file.path);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, bytes);
    await chmod(outputPath, file.mode);
  }

  if (!existsSync(join(temporaryDirectory, PACKAGE_JSON_PATH))) {
    throw new Error("SEA Playwright runtime is missing playwright-core/package.json");
  }
  await writeFile(join(temporaryDirectory, MARKER_FILE), JSON.stringify(manifest, null, 2));
  await mkdir(dirname(cacheDirectory), { recursive: true });
  await rm(cacheDirectory, { force: true, recursive: true });
  await rename(temporaryDirectory, cacheDirectory);
  return cacheDirectory;
}

function readManifest(sea: SeaModule): SeaPlaywrightManifest {
  const parsed = JSON.parse(sea.getAsset(MANIFEST_ASSET_KEY, "utf8")) as SeaPlaywrightManifest;
  if (
    parsed.version !== 1 ||
    !parsed.hash ||
    !parsed.packageVersion ||
    !parsed.target ||
    !Array.isArray(parsed.files)
  ) {
    throw new Error("Invalid SEA Playwright runtime manifest");
  }
  return parsed;
}

async function isCacheCurrent(
  markerPath: string,
  expected: SeaPlaywrightManifest,
): Promise<boolean> {
  if (!existsSync(markerPath)) return false;
  try {
    const current = JSON.parse(await readFile(markerPath, "utf8")) as SeaPlaywrightManifest;
    return current.hash === expected.hash && current.target === expected.target;
  } catch {
    return false;
  }
}

function assertSafeRuntimePath(filePath: string): void {
  const normalized = normalize(filePath);
  if (
    normalized.startsWith(`..${sep}`) ||
    normalized === ".." ||
    !normalized.startsWith(`node_modules${sep}playwright-core${sep}`)
  ) {
    throw new Error(`Invalid SEA Playwright asset path: ${filePath}`);
  }
}

function cacheBaseDirectory(): string {
  const home = homedir();
  if (platform() === "darwin" && home) {
    return join(home, "Library", "Caches", "lcode", "sea-assets");
  }
  if (platform() === "win32") {
    return join(
      process.env.LOCALAPPDATA ?? join(home || tmpdir(), "AppData", "Local"),
      "lcode",
      "Cache",
      "sea-assets",
    );
  }
  return join(
    process.env.XDG_CACHE_HOME ?? join(home || tmpdir(), ".cache"),
    "lcode",
    "sea-assets",
  );
}
