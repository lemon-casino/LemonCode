#!/usr/bin/env node

import { stat } from "node:fs/promises";
import { extname, resolve } from "node:path";

const argv = process.argv.slice(2);

function readArg(name) {
  const index = argv.indexOf(name);
  if (index === -1) {
    return null;
  }
  return argv[index + 1] ?? null;
}

const artifactPath = readArg("--artifact-path");
if (!artifactPath) {
  throw new Error("Usage: audit-bundle-size.mjs --artifact-path <path-to-artifact>");
}

const absoluteArtifactPath = resolve(artifactPath);
const limitsMb = {
  default: 500,
  ".dmg": 500,
  ".zip": 500,
  ".exe": 500,
  ".appimage": 500,
  ".deb": 500,
};

function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

const artifactStat = await stat(absoluteArtifactPath);
const extension = extname(absoluteArtifactPath).toLowerCase();
const additionalRuntimeBytes = Number(readArg("--additional-runtime-bytes") ?? 0);
if (!Number.isSafeInteger(additionalRuntimeBytes) || additionalRuntimeBytes < 0)
  throw new Error("Invalid additional runtime bytes");
// 本地包新增的远端压缩资产已经由 bundle 校验；只为这些实际字节增加额度，原应用预算不变。
const limit = (limitsMb[extension] ?? limitsMb.default) + additionalRuntimeBytes / 1024 / 1024;
const sizeMiB = artifactStat.size / 1024 / 1024;

console.log(`Artifact: ${absoluteArtifactPath}`);
console.log(`Type: ${extension || "<no-extension>"}`);
console.log(`Size: ${formatMiB(artifactStat.size)}`);
if (additionalRuntimeBytes)
  console.log(`Included remote runtime: ${formatMiB(additionalRuntimeBytes)}`);
console.log(`Limit: ${limit} MiB`);

if (sizeMiB > limit) {
  console.error("Bundle size audit failed:");
  console.error(`  - Artifact exceeds ${limit} MiB`);
  process.exit(1);
}
