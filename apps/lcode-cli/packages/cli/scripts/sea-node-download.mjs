import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { nodeReleaseArtifact, targetParts } from "./sea-targets.mjs";

const commandText = (command, args) => [command, ...args].join(" ");

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "inherit",
    ...options,
  });

  if (result.error) {
    throw new Error(`${commandText(command, args)} failed: ${result.error.message}`, {
      cause: result.error,
    });
  }

  if (result.status !== 0) {
    throw new Error(`${commandText(command, args)} failed`);
  }
};

const sha256File = async (file) => {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
};

const formatBytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

export const downloadFile = async (url, destination) => {
  console.log(`[sea] downloading ${url}`);
  const response = await fetch(url, {
    redirect: "follow",
  });

  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }

  await mkdir(dirname(destination), {
    recursive: true,
  });

  const tempDestination = `${destination}.download`;
  await rm(tempDestination, {
    force: true,
  });

  const contentLength = Number(response.headers.get("content-length") ?? 0);
  let received = 0;
  let lastProgressAt = Date.now();
  const body = Readable.fromWeb(response.body);
  body.on("data", (chunk) => {
    received += chunk.length;
    const now = Date.now();

    if (now - lastProgressAt < 5_000) return;

    lastProgressAt = now;
    const total = contentLength > 0 ? ` / ${formatBytes(contentLength)}` : "";
    console.log(`[sea] downloaded ${formatBytes(received)}${total}`);
  });

  try {
    await pipeline(body, createWriteStream(tempDestination));
    await rename(tempDestination, destination);
  } catch (error) {
    await rm(tempDestination, {
      force: true,
    });
    throw error;
  }
};

const shasumsPath = (nodeCache, nodeVersion) =>
  resolve(nodeCache, `v${nodeVersion}`, "SHASUMS256.txt");

const ensureShasums = async ({ nodeCache, nodeVersion }) => {
  const destination = shasumsPath(nodeCache, nodeVersion);

  if (!existsSync(destination)) {
    await downloadFile(`https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`, destination);
  }

  return readFile(destination, "utf8");
};

const expectedSha256 = (shasums, artifact) => {
  for (const line of shasums.split(/\r?\n/)) {
    const [hash, name] = line.trim().split(/\s+/);

    if (name === artifact) return hash;
  }

  throw new Error(`Could not find ${artifact} in Node.js SHASUMS256.txt`);
};

const ensureDownloadedArtifact = async ({ artifact, destination, nodeCache, nodeVersion }) => {
  const shasums = await ensureShasums({ nodeCache, nodeVersion });
  const expected = expectedSha256(shasums, artifact);

  if (existsSync(destination)) {
    const actual = await sha256File(destination);
    if (actual === expected) return;

    console.log(`[sea] cached ${artifact} checksum mismatch; downloading again`);
    await rm(destination, {
      force: true,
    });
  }

  await downloadFile(
    new URL(artifact, `https://nodejs.org/dist/v${nodeVersion}/`).href,
    destination,
  );

  const actual = await sha256File(destination);
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${artifact}: expected ${expected}, received ${actual}`);
  }
};

const releaseArchiveRoot = (target, nodeVersion) => {
  const { arch, releasePlatform } = targetParts(target);
  return `node-v${nodeVersion}-${releasePlatform}-${arch}`;
};

const ensureExtractedNode = async ({ archivePath, extractRoot, nodeVersion, target }) => {
  const nodePath = resolve(extractRoot, releaseArchiveRoot(target, nodeVersion), "bin", "node");

  if (existsSync(nodePath)) return nodePath;

  await rm(extractRoot, {
    force: true,
    recursive: true,
  });
  await mkdir(extractRoot, {
    recursive: true,
  });

  try {
    run("tar", ["-xf", archivePath, "-C", extractRoot]);
  } catch (error) {
    throw new Error(
      `Could not extract ${archivePath}. Install tar/xz support or pass --node-binary ${target}=/abs/path/node.`,
      {
        cause: error,
      },
    );
  }

  if (!existsSync(nodePath)) {
    throw new Error(`Extracted Node.js archive did not contain ${nodePath}`);
  }

  return nodePath;
};

export const resolveDownloadedNodeBinary = async ({ nodeCache, nodeVersion, target }) => {
  const artifact = nodeReleaseArtifact(target, nodeVersion);
  const artifactPath = resolve(nodeCache, `v${nodeVersion}`, artifact);

  await ensureDownloadedArtifact({
    artifact,
    destination: artifactPath,
    nodeCache,
    nodeVersion,
  });

  const { releasePlatform } = targetParts(target);
  if (releasePlatform === "win") return artifactPath;

  return ensureExtractedNode({
    archivePath: artifactPath,
    extractRoot: resolve(nodeCache, `v${nodeVersion}`, target),
    nodeVersion,
    target,
  });
};
