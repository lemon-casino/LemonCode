import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";
import { isPathWithin } from "./backendPlatform.js";

const execFileAsync = promisify(execFile);
const MAX_ARCHIVE_ENTRIES = 128;
const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024;

export async function extractZipArchive(
  archivePath: string,
  destination: string,
  requiredMembers: readonly string[],
): Promise<void> {
  const archive = await readFile(archivePath);
  const entries = parseZipEntries(archive);
  const required = new Set(requiredMembers);
  const baseOffset = findZipBaseOffset(archive, entries[0]);
  const extracted = new Set<string>();

  for (const entry of entries) {
    validateArchiveMember(entry.path, required);
    if (entry.kind === "symlink" || entry.kind === "special") {
      throw new Error(`mise archive contains unsupported link or special member: ${entry.path}`);
    }
    if (entry.kind !== "file") continue;
    const content = readZipEntry(archive, entry, baseOffset);
    const relativePath = entry.path.slice("mise/".length);
    const target = resolve(destination, relativePath);
    if (!isPathWithin(destination, target)) {
      throw new Error(`archive member escapes destination: ${entry.path}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    extracted.add(entry.path);
  }

  assertRequiredMembers(extracted, required);
}

export async function extractTarXzArchive(
  archivePath: string,
  destination: string,
  requiredMembers: readonly string[],
): Promise<void> {
  const names = await runTar(["-tf", archivePath]);
  const details = await runTar(["-tvf", archivePath]);
  const nameLines = splitArchiveLines(names.stdout);
  const detailLines = splitArchiveLines(details.stdout);
  if (nameLines.length !== detailLines.length || nameLines.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error("mise tar archive listing is inconsistent or too large");
  }
  const required = new Set(requiredMembers);
  const extractable = new Set<string>();
  for (let index = 0; index < nameLines.length; index += 1) {
    const member = nameLines[index];
    if (member === undefined) throw new Error("mise tar archive listing is inconsistent");
    validateArchiveMember(member, required);
    const type = detailLines[index]?.[0];
    if (type !== "-" && type !== "d") {
      throw new Error(`mise tar archive contains unsupported link or special member: ${member}`);
    }
    if (type === "-") extractable.add(member);
  }
  assertRequiredMembers(extractable, required);

  await runTar([
    "-xf",
    archivePath,
    "-C",
    destination,
    "--strip-components=1",
    "--",
    ...required,
  ]);
}

interface ZipEntry {
  path: string;
  kind: "file" | "directory" | "symlink" | "special";
  compressedSize: number;
  uncompressedSize: number;
  compression: number;
  localOffset: number;
}

function parseZipEntries(archive: Buffer): ZipEntry[] {
  const eocd = findSignatureFromEnd(archive, 0x06054b50, 22 + 0xffff);
  if (eocd < 0) throw new Error("mise zip archive has no end record");
  const totalEntries = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  if (totalEntries > MAX_ARCHIVE_ENTRIES || centralSize > archive.length) {
    throw new Error("mise zip archive has too many or too-large members");
  }
  const firstLocal = archive.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const candidates = [centralOffset, firstLocal >= 0 ? centralOffset + firstLocal : -1];
  const start = candidates.find(
    (candidate) => candidate >= 0 && candidate + 4 <= archive.length && archive.readUInt32LE(candidate) === 0x02014b50,
  );
  if (start === undefined) throw new Error("mise zip central directory is invalid");

  const entries: ZipEntry[] = [];
  let offset = start;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("mise zip central directory is truncated");
    }
    const madeBy = archive.readUInt16LE(offset + 4);
    const flags = archive.readUInt16LE(offset + 8);
    const compression = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const localOffset = archive.readUInt32LE(offset + 42);
    if (flags & 0x1 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new Error("mise zip encryption or zip64 members are unsupported");
    }
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd + extraLength + commentLength > archive.length) {
      throw new Error("mise zip member metadata is truncated");
    }
    const path = archive.subarray(nameStart, nameEnd).toString("utf8");
    const unixMode = externalAttributes >>> 16;
    const isDirectory =
      path.endsWith("/") || (madeBy >> 8 === 3 && (unixMode & 0xf000) === 0x4000);
    const kind = isDirectory
      ? "directory"
      : (madeBy >> 8 === 3 && (unixMode & 0xf000) === 0xa000)
        ? "symlink"
        : (madeBy >> 8 === 3 && unixMode !== 0 && (unixMode & 0xf000) !== 0x8000)
          ? "special"
          : "file";
    entries.push({ path, kind, compressedSize, uncompressedSize, compression, localOffset });
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

function findZipBaseOffset(archive: Buffer, firstEntry: ZipEntry | undefined): number {
  if (!firstEntry) throw new Error("mise zip archive has no members");
  const localOffset = firstEntry.localOffset;
  const local = archive.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (local < 0 || local < localOffset) throw new Error("mise zip local directory is invalid");
  return local - localOffset;
}

function readZipEntry(archive: Buffer, entry: ZipEntry, baseOffset: number): Buffer {
  const local = baseOffset + entry.localOffset;
  if (local + 30 > archive.length || archive.readUInt32LE(local) !== 0x04034b50) {
    throw new Error(`mise zip local member is invalid: ${entry.path}`);
  }
  const nameLength = archive.readUInt16LE(local + 26);
  const extraLength = archive.readUInt16LE(local + 28);
  const start = local + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > archive.length) throw new Error(`mise zip member is truncated: ${entry.path}`);
  const compressed = archive.subarray(start, end);
  let content: Buffer;
  if (entry.compression === 0) content = Buffer.from(compressed);
  else if (entry.compression === 8) content = inflateRawSync(compressed);
  else throw new Error(`mise zip compression is unsupported: ${entry.path}`);
  if (content.byteLength !== entry.uncompressedSize) {
    throw new Error(`mise zip member size mismatch: ${entry.path}`);
  }
  return content;
}

function findSignatureFromEnd(buffer: Buffer, signature: number, maxBytes: number): number {
  const start = Math.max(0, buffer.length - maxBytes);
  for (let offset = buffer.length - 4; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) return offset;
  }
  return -1;
}

async function runTar(args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("tar", args, {
      windowsHide: true,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    });
  } catch (error) {
    const output = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(`mise tar archive operation failed: ${output.stderr ?? output.message ?? String(error)}`);
  }
}

function splitArchiveLines(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.replace(/\r$/u, ""))
    .filter((line) => line.length > 0);
}

function validateArchiveMember(member: string, required: ReadonlySet<string>): void {
  if (!member || member.includes("\0") || member.includes("\\")) {
    throw new Error(`mise archive member path is unsafe: ${JSON.stringify(member)}`);
  }
  if (member.startsWith("/") || /^[A-Za-z]:/u.test(member)) {
    throw new Error(`mise archive member path is absolute: ${member}`);
  }
  const directory = member.endsWith("/");
  const path = directory ? member.slice(0, -1) : member;
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`mise archive member path traverses directories: ${member}`);
  }
  if (path !== "mise" && (!path.startsWith("mise/") || posix.normalize(path) !== path)) {
    throw new Error(`mise archive member path is not rooted at mise: ${member}`);
  }
  if (directory) {
    const allowed = path === "mise" || [...required].some((item) => item.startsWith(`${path}/`));
    if (!allowed) throw new Error(`mise archive contains an unexpected directory: ${member}`);
  } else if (!required.has(member)) {
    throw new Error(`mise archive contains an unexpected member: ${member}`);
  }
}

function assertRequiredMembers(found: ReadonlySet<string>, required: ReadonlySet<string>): void {
  for (const member of required) {
    if (!found.has(member)) throw new Error(`mise archive is missing required member: ${member}`);
  }
}
