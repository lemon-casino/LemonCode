import { lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { constants as zlibConstants, gzipSync } from "node:zlib";

function collectDeterministicTarEntries(sourcePath, { executablePaths = [] } = {}) {
  const executableEntries = new Set(executablePaths);
  const sourceStat = lstatSync(sourcePath);
  const entries = [];

  function visit(currentPath, relativePath) {
    const currentStat = lstatSync(currentPath);
    if (currentStat.isDirectory()) {
      if (relativePath) {
        entries.push({
          type: "directory",
          relativePath: `${relativePath.replace(/\/+$/u, "")}/`,
        });
      }
      const children = readdirSync(currentPath)
        .slice()
        .sort((left, right) => left.localeCompare(right, "en"));
      for (const child of children) {
        visit(join(currentPath, child), relativePath ? `${relativePath}/${child}` : child);
      }
      return;
    }

    if (currentStat.isSymbolicLink()) {
      entries.push({
        type: "symlink",
        relativePath,
        linkName: readlinkSync(currentPath).replace(/\\/gu, "/"),
      });
      return;
    }

    if (!currentStat.isFile()) {
      throw new Error(`Unsupported component archive entry: ${currentPath}`);
    }

    entries.push({
      type: "file",
      relativePath,
      // Windows chmod 不保存 POSIX 执行位；按构建合同显式指定目标可执行文件，而不是执行异构二进制。
      mode: executableEntries.has(relativePath) || currentStat.mode & 0o111 ? 0o755 : 0o644,
      data: readFileSync(currentPath),
    });
  }

  if (sourceStat.isDirectory()) {
    visit(sourcePath, "");
    return entries;
  }

  visit(sourcePath, basename(sourcePath));
  return entries;
}

function writeTarOctal(buffer, offset, length, value) {
  const text = Math.trunc(value)
    .toString(8)
    .padStart(length - 1, "0");
  buffer.write(text.slice(-(length - 1)), offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0;
}

function splitTarPath(relativePath) {
  const normalizedPath = relativePath.replace(/\\/gu, "/");
  if (Buffer.byteLength(normalizedPath) <= 100) {
    return { name: normalizedPath, prefix: "" };
  }

  const parts = normalizedPath.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    const prefix = parts.slice(0, index).join("/");
    const name = parts.slice(index).join("/");
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }

  throw new Error(`Component archive path is too long for ustar: ${relativePath}`);
}

function buildTarHeader(entry) {
  const header = Buffer.alloc(512, 0);
  const { name, prefix } = splitTarPath(entry.relativePath);
  const mode = entry.type === "file" ? entry.mode : entry.type === "directory" ? 0o755 : 0o777;
  const size = entry.type === "file" ? entry.data.length : 0;
  const typeFlag = entry.type === "directory" ? "5" : entry.type === "symlink" ? "2" : "0";

  header.write(name, 0, 100, "utf8");
  writeTarOctal(header, 100, 8, mode);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(typeFlag, 156, 1, "ascii");
  if (entry.type === "symlink") {
    header.write(entry.linkName, 157, 100, "utf8");
  }
  header.write("ustar", 257, 5, "ascii");
  header[262] = 0;
  header.write("00", 263, 2, "ascii");
  header.write("root", 265, 32, "ascii");
  header.write("root", 297, 32, "ascii");
  header.write(prefix, 345, 155, "utf8");

  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumText = checksum.toString(8).padStart(6, "0");
  header.write(checksumText.slice(-6), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

export function packSourceAsDeterministicTarGzip(sourcePath, artifactPath, options) {
  const chunks = [];
  for (const entry of collectDeterministicTarEntries(sourcePath, options)) {
    chunks.push(buildTarHeader(entry));
    if (entry.type !== "file") continue;

    chunks.push(entry.data);
    const padding = (512 - (entry.data.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));

  // 归档路径会作为静态 deps 资源长期复用；固定 tar 元数据与 gzip mtime，避免同一二进制
  // 因 producer 的用户、目录或时间不同而生成不同归档。
  const archive = gzipSync(Buffer.concat(chunks), {
    filename: "",
    level: zlibConstants.Z_BEST_COMPRESSION,
    mtime: 0,
  });
  archive[9] = 255;
  writeFileSync(artifactPath, archive);
}

export function computeDeterministicSourceSha256(sourcePath, options) {
  const hash = createHash("sha256");
  for (const entry of collectDeterministicTarEntries(sourcePath, options)) {
    hash.update(
      `${JSON.stringify({
        type: entry.type,
        relativePath: entry.relativePath,
        mode: entry.mode,
        linkName: entry.linkName,
        size: entry.type === "file" ? entry.data.length : 0,
      })}\n`,
      "utf8",
    );
    if (entry.type === "file") {
      hash.update(entry.data);
      hash.update("\n", "utf8");
    }
  }
  return hash.digest("hex");
}
