import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Explicit maintenance command; never runs while a user signs in.
const revision = "da7e2f67a5c7c2fe2ca776156d08ce2f144e86dd";
const names = [
  "cline",
  "commandcode",
  "cursor",
  "devin",
  "factory",
  "grok",
  "kiro",
  "minimax",
  "mimo",
  "qoder",
  "trae",
  "workbuddy",
  "zcode",
  "zed",
  "zen-free",
];
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = process.argv[2] && resolve(process.argv[2]);
if (!source) throw new Error("Usage: node scripts/sync-auth-plugin-vendor.mjs <plugins-checkout>");
const { stdout } = await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: source });
if (stdout.trim() !== revision) throw new Error(`Expected pinned upstream revision ${revision}`);
await promisify(execFile)("git", ["diff", "--quiet", "HEAD", "--", "packages", "LICENSE"], {
  cwd: source,
});
const destination = join(root, "packages/provider-node/src/provider-auth/vendor");
await mkdir(destination, { recursive: true });
await writeFile(join(destination, "LICENSE"), await readFile(join(source, "LICENSE")));
const manifest = {
  repository: "https://github.com/magpie-community/plugins",
  revision,
  packages: [],
};
for (const name of names) {
  const folder = join(source, "packages", name);
  const pkg = JSON.parse(await readFile(join(folder, "package.json"), "utf8"));
  const files = new Set(["index.mjs"]);
  // Copy only transitive runtime modules, never tests, installation hooks or credentials.
  for (const file of files) {
    const content = await readFile(join(folder, file), "utf8");
    for (const match of content.matchAll(/(?:from\s*|import\s*)["'](\.\/[^"']+)["']/g)) {
      if (match[1].endsWith(".mjs")) files.add(match[1].slice(2));
    }
  }
  const copied = [];
  for (const file of files) {
    const bytes = await readFile(join(folder, file));
    const target = join(destination, name, file + ".source");
    await mkdir(dirname(target), { recursive: true });
    // .source keeps immutable third-party code out of TypeScript/lint. The build script
    // loads it as JavaScript and embeds the complete bundle in a static TS import.
    await writeFile(target, bytes);
    copied.push({
      file: file + ".source",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  for (const file of await readdir(folder)) {
    if (!file.startsWith("LICENSE")) continue;
    await writeFile(join(destination, name, file), await readFile(join(folder, file)));
  }
  manifest.packages.push({
    directory: name,
    name: pkg.name,
    version: pkg.version,
    license: pkg.license,
    files: copied,
  });
}
await writeFile(join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
process.stdout.write(`Vendored ${manifest.packages.length} provider packages at ${revision}\n`);
