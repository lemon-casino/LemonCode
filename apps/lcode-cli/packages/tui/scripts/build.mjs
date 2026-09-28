import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const tuiDirectory = resolve(import.meta.dirname, "..");

export async function buildTui() {
  const manifest = JSON.parse(await readFile(resolve(tuiDirectory, "package.json"), "utf8"));
  await build({
    entryPoints: [resolve(tuiDirectory, "src/index.ts")],
    outfile: resolve(tuiDirectory, "dist/index.js"),
    bundle: true,
    // Workspace exports can point at TypeScript sources. Compile that closure here;
    // OpenTUI and its native/worker assets must retain their package-relative paths.
    external: Object.keys(manifest.dependencies).filter((name) => !name.startsWith("@lcode/")),
    format: "esm",
    platform: "node",
    target: "node22",
    sourcemap: true,
    logLevel: "info",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildTui();
}
