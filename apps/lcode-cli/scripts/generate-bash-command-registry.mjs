import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FIG_VERSION = "2.692.3";
const MAX_GENERATED_BYTES = 3 * 1024 * 1024;
const GENERATED_RELATIVE_PATH =
  "packages/core/src/tool/handlers/generated/bash-command-registry.ts";
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_OUTPUT = join(APP_ROOT, GENERATED_RELATIVE_PATH);

const ARG_FLAGS = Object.freeze({
  command: 1,
  module: 2,
  variadic: 4,
  optional: 8,
  dangerous: 16,
  file: 32,
  folder: 64,
});

const counters = {
  imported: 0,
  skippedImport: 0,
  skippedDynamicSubcommands: 0,
  skippedInvalidNodes: 0,
  skippedLoadSpecNodes: 0,
};

const check = process.argv.includes("--check");
const outputArgIndex = process.argv.indexOf("--output");
const explicitOutput =
  outputArgIndex >= 0 && process.argv[outputArgIndex + 1]
    ? resolve(process.argv[outputArgIndex + 1])
    : undefined;

const packageEntry = fileURLToPath(import.meta.resolve("@withfig/autocomplete"));
const buildDirectory = dirname(packageEntry);
const packageDirectory = dirname(buildDirectory);
const packageJson = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
if (packageJson.version !== FIG_VERSION) {
  throw new Error(
    `Expected @withfig/autocomplete@${FIG_VERSION}, received ${String(packageJson.version)}`,
  );
}

const rootFiles = (await readdir(buildDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".js") && entry.name !== "index.js")
  .map((entry) => entry.name)
  .sort();

const registryEntries = [];
for (const fileName of rootFiles) {
  try {
    const module = await import(pathToFileURL(join(buildDirectory, fileName)).href);
    const node = compactNode(module.default, basename(fileName, ".js"));
    if (!node) {
      counters.skippedInvalidNodes += 1;
      continue;
    }
    counters.imported += 1;
    for (const name of node[0]) {
      registryEntries.push([name, node]);
    }
  } catch {
    counters.skippedImport += 1;
  }
}

registryEntries.sort(([left], [right]) => left.localeCompare(right));
const registry = Object.fromEntries(registryEntries);
const contentHash = await hashBuildFiles(buildDirectory);
const generated = renderGeneratedModule(registry, contentHash, counters);
const generatedBytes = Buffer.byteLength(generated);
if (generatedBytes > MAX_GENERATED_BYTES) {
  throw new Error(
    `Generated Bash command registry is ${generatedBytes} bytes; limit is ${MAX_GENERATED_BYTES}`,
  );
}

if (check) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "lcode-bash-registry-"));
  const temporaryOutput = join(temporaryDirectory, "bash-command-registry.ts");
  try {
    await writeFile(temporaryOutput, generated);
    const [actual, expected] = await Promise.all([
      readFile(temporaryOutput),
      readFile(DEFAULT_OUTPUT),
    ]);
    if (!actual.equals(expected)) {
      throw new Error(
        "Generated Bash command registry is stale. Run `pnpm --dir apps/lcode-cli registry:generate`.",
      );
    }
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
} else {
  const output = explicitOutput ?? DEFAULT_OUTPUT;
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, generated);
}

console.log(
  JSON.stringify({
    bytes: generatedBytes,
    figVersion: FIG_VERSION,
    hash: contentHash,
    roots: Object.keys(registry).length,
    skipped: {
      dynamicSubcommands: counters.skippedDynamicSubcommands,
      imports: counters.skippedImport,
      invalidNodes: counters.skippedInvalidNodes,
      loadSpecNodes: counters.skippedLoadSpecNodes,
    },
  }),
);

function compactNode(value, fallbackName) {
  if (!isRecord(value)) return undefined;
  const names = normalizeNames(value.name ?? fallbackName);
  if (names.length === 0) return undefined;

  const options = normalizeArray(value.options)
    .map(compactOption)
    .filter(Boolean)
    .sort(compareTupleNames);
  const argsFlags = compactArgs(value.args);
  let children = [];
  if (typeof value.subcommands === "function") {
    counters.skippedDynamicSubcommands += 1;
  } else {
    children = normalizeArray(value.subcommands)
      .map((child) => compactNode(child, undefined))
      .filter(Boolean)
      .sort(compareTupleNames);
  }
  if (value.loadSpec !== undefined && children.length === 0) {
    counters.skippedLoadSpecNodes += 1;
  }
  return [names, options, argsFlags, children];
}

function compactOption(value) {
  if (!isRecord(value)) return undefined;
  const names = normalizeNames(value.name);
  if (names.length === 0) return undefined;
  return [names, compactArgs(value.args) !== 0 ? 1 : 0];
}

function compactArgs(value) {
  let flags = 0;
  for (const arg of normalizeArray(value)) {
    if (!isRecord(arg)) continue;
    if (arg.isCommand === true) flags |= ARG_FLAGS.command;
    if (arg.isModule === true) flags |= ARG_FLAGS.module;
    if (arg.isVariadic === true) flags |= ARG_FLAGS.variadic;
    if (arg.isOptional === true) flags |= ARG_FLAGS.optional;
    if (arg.isDangerous === true) flags |= ARG_FLAGS.dangerous;
    const templates = normalizeArray(arg.template).filter((item) => typeof item === "string");
    if (templates.some((item) => item === "filepaths" || item === "file")) {
      flags |= ARG_FLAGS.file;
    }
    if (templates.some((item) => item === "folders" || item === "folder")) {
      flags |= ARG_FLAGS.folder;
    }
  }
  return flags;
}

function normalizeNames(value) {
  return [...new Set(normalizeArray(value).filter((item) => typeof item === "string"))].sort();
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function compareTupleNames(left, right) {
  return (left?.[0]?.[0] ?? "").localeCompare(right?.[0]?.[0] ?? "");
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

async function hashBuildFiles(directory) {
  const files = await listFiles(directory);
  const hash = createHash("sha256");
  for (const filePath of files) {
    const relativePath = filePath.slice(directory.length + 1);
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await readFile(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function listFiles(directory) {
  const entries = await readdir(directory);
  const files = [];
  for (const entry of entries.sort()) {
    const filePath = join(directory, entry);
    if ((await stat(filePath)).isDirectory()) {
      files.push(...(await listFiles(filePath)));
    } else {
      files.push(filePath);
    }
  }
  return files;
}

function renderGeneratedModule(registry, contentHash, stats) {
  return `/* eslint-disable */\n` +
    `// 此文件由 scripts/generate-bash-command-registry.mjs 确定性生成，请勿手改。\n` +
    `// Source: @withfig/autocomplete@${FIG_VERSION} (ISC); hash: ${contentHash}.\n` +
    `// Skipped: imports=${stats.skippedImport}, dynamicSubcommands=${stats.skippedDynamicSubcommands}, invalidNodes=${stats.skippedInvalidNodes}, loadSpecNodes=${stats.skippedLoadSpecNodes}.\n` +
    `export type BashCommandRegistryOption = readonly [readonly string[], 0 | 1];\n` +
    `export type BashCommandRegistryNode = readonly [readonly string[], readonly BashCommandRegistryOption[], number, readonly BashCommandRegistryNode[]];\n` +
    `export const BASH_COMMAND_REGISTRY_VERSION = "fig-${FIG_VERSION}";\n` +
    `export const BASH_COMMAND_REGISTRY_HASH = "${contentHash}";\n` +
    `export const BASH_COMMAND_REGISTRY: Readonly<Record<string, BashCommandRegistryNode>> = ${JSON.stringify(registry)};\n`;
}
