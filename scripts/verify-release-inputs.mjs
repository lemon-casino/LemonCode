// Copyright 2026 Lemon (zcode-full). SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readReleaseVerifiedNotices, repositoryRoot } from "./third-party-notices.mjs";

const metadata = [
  "third-party/inventory.json",
  "THIRD-PARTY-NOTICES.md",
  "third-party/release-review-baseline.json",
];
const controls = [
  "package.json",
  "LICENSE",
  "NOTICE.md",
  ".gitignore",
  ".gitattributes",
  ".github/workflows/desktop-release.yml",
  "scripts/verify-release-inputs.mjs",
  "scripts/third-party-notices.mjs",
  "scripts/verify-release-version.mjs",
];

function git(root, args, input) {
  return new Promise((done, reject) => {
    // 修复：库存源码与 NOTICE 总量超过 execFile 默认 1 MiB，批量对象读取必须显式有界扩容。
    const child = execFile(
      "git",
      args,
      { cwd: root, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(
              `Release Git command failed: ${args.join(" ")}: ${stderr.toString().trim() || error.message}`,
              { cause: error },
            ),
          );
        else done(stdout);
      },
    );
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin.end(input);
  });
}

async function snapshotEntries(root, source) {
  const args =
    source === "index"
      ? ["ls-files", "--stage", "--full-name", "-z"]
      : ["ls-tree", "-r", "-z", "--full-tree", "HEAD"];
  const output = await git(root, args);
  const entries = new Map();
  for (const line of output.toString("utf8").split("\0").filter(Boolean)) {
    const match =
      source === "index"
        ? /^([0-7]{6}) ([a-f\d]{40,64}) ([0-3])\t([\s\S]+)$/u.exec(line)
        : /^([0-7]{6}) (blob|tree|commit) ([a-f\d]{40,64})\t([\s\S]+)$/u.exec(line);
    if (!match) throw new Error("Invalid Git snapshot entry");
    if (source === "index" && match[3] !== "0")
      throw new Error(`Unmerged Git index: ${JSON.stringify(match[4])}`);
    entries.set(match[4], { mode: match[1], oid: source === "index" ? match[2] : match[3] });
  }
  return entries;
}

async function readBlobs(root, entries, files, cache, source) {
  const missing = files.filter((file) => !entries.has(file));
  if (missing.length)
    throw new Error(
      `Release Git ${source} missing ${missing.length} input(s):\n${missing.map((file) => JSON.stringify(file)).join("\n")}\nInclude these files in the selected Git snapshot; local files do not count.`,
    );
  for (const file of files) {
    if (!["100644", "100755"].includes(entries.get(file).mode))
      throw new Error(`Release input must be a regular Git blob: ${JSON.stringify(file)}`);
  }
  const oids = [
    ...new Set(
      files
        .filter((file) => !cache.has(entries.get(file).oid))
        .map((file) => entries.get(file).oid),
    ),
  ];
  if (!oids.length) return;
  const bytes = await git(root, ["cat-file", "--batch"], `${oids.join("\n")}\n`);
  let offset = 0;
  for (const oid of oids) {
    const end = bytes.indexOf(10, offset);
    const header = bytes.subarray(offset, end).toString("ascii");
    const match = /^([a-f\d]{40,64}) blob (\d+)$/u.exec(header);
    if (end < offset || !match || match[1] !== oid)
      throw new Error(`Invalid Git blob response for ${oid}`);
    const size = Number(match[2]);
    offset = end + 1;
    if (!Number.isSafeInteger(size) || offset + size >= bytes.length || bytes[offset + size] !== 10)
      throw new Error(`Truncated Git blob response for ${oid}`);
    cache.set(oid, bytes.subarray(offset, offset + size));
    offset += size + 1;
  }
  if (offset !== bytes.length) throw new Error("Unexpected Git blob response bytes");
}

function inventoryInputs(manifest) {
  if (
    !manifest ||
    manifest.schemaVersion !== 1 ||
    !manifest.inputs ||
    typeof manifest.inputs !== "object" ||
    Array.isArray(manifest.inputs) ||
    !Object.keys(manifest.inputs).length
  )
    throw new Error("Invalid release inventory inputs");
  for (const [file, hash] of Object.entries(manifest.inputs)) {
    // 修复：posix.isAbsolute 不识别 Windows 盘符/ADS，禁止冒号、反斜杠及越界段再解析路径。
    if (
      !file ||
      /[\\:\0]/u.test(file) ||
      file.split("/").some((part) => !part || part === "." || part === "..") ||
      typeof hash !== "string" ||
      !/^[a-f\d]{64}$/u.test(hash)
    )
      throw new Error(`Invalid release inventory input: ${JSON.stringify(file)}`);
  }
  return Object.keys(manifest.inputs);
}

export async function verifyReleaseInputs({ root = repositoryRoot, source = "index" } = {}) {
  if (!["index", "HEAD"].includes(source)) throw new Error(`Unsupported Git source: ${source}`);
  root = resolve(root);
  const entries = await snapshotEntries(root, source);
  const cache = new Map();
  await readBlobs(root, entries, [...metadata, ...controls], cache, source);
  const blob = (file) => cache.get(entries.get(file)?.oid);
  let manifest;
  try {
    manifest = JSON.parse(blob(metadata[0]).toString("utf8"));
  } catch (error) {
    throw new Error("Invalid release inventory JSON", { cause: error });
  }
  const inputs = inventoryInputs(manifest);
  await readBlobs(root, entries, inputs, cache, source);
  // 修复：工作区存在被忽略材料不能证明提交完整；所有读取只来自固定的 Git 对象 ID。
  await readReleaseVerifiedNotices(root, {
    async readFile(path, encoding) {
      const file = relative(root, path).replaceAll("\\", "/");
      const bytes = blob(file);
      if (!bytes)
        throw new Error(`Release Git ${source} unreadable input: ${JSON.stringify(file)}`);
      return encoding === "utf8" ? bytes.toString("utf8") : bytes;
    },
  });
  return { source, inputCount: inputs.length, reviewRequiredCount: manifest.reviewRequired.length };
}

async function main(args) {
  if (args.length > 1 || (args.length && !/^--source=(index|HEAD)$/u.test(args[0])))
    throw new Error("Usage: node scripts/verify-release-inputs.mjs [--source=index|HEAD]");
  const result = await verifyReleaseInputs({
    source: args[0]?.slice("--source=".length) ?? "index",
  });
  console.log(
    `Release Git ${result.source}: ${result.inputCount} inputs verified; ${result.reviewRequiredCount} recorded material gaps retained.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
