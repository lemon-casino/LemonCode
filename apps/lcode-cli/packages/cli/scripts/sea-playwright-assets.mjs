import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export const seaPlaywrightAssetPrefix = "lcode-playwright-runtime/";
export const seaPlaywrightManifestAssetKey = `${seaPlaywrightAssetPrefix}manifest.json`;

export const collectSeaPlaywrightAssets = async ({ root, stagingDirectory, target }) => {
  const packageRoot = resolvePlaywrightPackageRoot(root);
  const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const assets = {};
  const files = [];

  await rm(stagingDirectory, { force: true, recursive: true });

  for await (const sourcePath of walkFiles(packageRoot)) {
    const relativePath = toPosixPath(relative(packageRoot, sourcePath));
    const assetPath = `node_modules/playwright-core/${relativePath}`;
    const bytes = await readFile(sourcePath);
    const sourceStats = await stat(sourcePath);
    assets[`${seaPlaywrightAssetPrefix}${assetPath}`] = sourcePath;
    files.push({
      mode: modeForFile(sourceStats.mode),
      path: assetPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  const hash = createHash("sha256")
    .update(JSON.stringify(files.map(({ path, sha256 }) => [path, sha256])))
    .digest("hex");
  const manifest = {
    files,
    hash,
    packageVersion: packageJson.version,
    target,
    version: 1,
  };
  const manifestPath = resolve(stagingDirectory, "playwright-manifest.json");
  await mkdir(stagingDirectory, { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  assets[seaPlaywrightManifestAssetKey] = manifestPath;

  return { assets, manifest };
};

const resolvePlaywrightPackageRoot = (root) => {
  const cliPackageJson = resolve(root, "packages", "cli", "package.json");
  const require = createRequire(cliPackageJson);
  try {
    return dirname(require.resolve("playwright-core/package.json"));
  } catch (error) {
    const fallback = resolve(root, "..", "..", "node_modules", "playwright-core");
    if (existsSync(join(fallback, "package.json"))) return fallback;
    throw new Error("Missing playwright-core runtime. Run `pnpm install` before `pnpm sea`.", {
      cause: error,
    });
  }
};

async function* walkFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) yield* walkFiles(fullPath);
    else if (entry.isFile()) yield fullPath;
  }
}

const modeForFile = (sourceMode) => ((sourceMode & 0o111) !== 0 ? 0o755 : 0o644);
const toPosixPath = (value) => value.split(sep).join("/");
