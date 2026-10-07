import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  CONFIGURATION_FILES,
  KNOWN_LOCKFILES,
  parseProjectDeclarations,
} from "../domain/declarations.js";
import type { DeclarationReaderPort } from "../app/ports.js";

interface FileStamp {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
  isFile(): boolean;
}
/** 仅适配器 IO 注入；默认仍用真实异步文件 API，内存 DeclarationReaderPort 不受影响。 */
export interface DeclarationReaderIO {
  stat(path: string): Promise<FileStamp>;
  open(path: string): Promise<{
    stat(): Promise<FileStamp>;
    read(
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ): Promise<{ bytesRead: number }>;
    close(): Promise<void>;
  }>;
}
const defaultIO: DeclarationReaderIO = {
  stat: (path) => stat(path),
  open: (path) => open(path, "r"),
};
const TEXT_FILES = ["mise.toml", ".node-version", ".nvmrc", "package.json"] as const;
const FILE_NAMES = [...TEXT_FILES, ...CONFIGURATION_FILES, ...KNOWN_LOCKFILES];
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const changed = (name: string) => new Error(`Declaration changed while reading: ${name}`);

async function statOptional(io: DeclarationReaderIO, path: string): Promise<FileStamp | undefined> {
  try {
    return await io.stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function sameFile(left: FileStamp | undefined, right: FileStamp | undefined): boolean {
  if (!left || !right) return left === right;
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.isFile() === right.isFile()
  );
}
function checkLimit(name: string, stamp: FileStamp) {
  if (!stamp.isFile()) throw new Error(`unsupported-declaration: ${name} is not a regular file`);
  const limit = KNOWN_LOCKFILES.includes(name) ? 32 * 1024 * 1024 : 1024 * 1024;
  if (!Number.isSafeInteger(stamp.size) || stamp.size < 0 || stamp.size > limit) {
    throw new Error(`unsupported-declaration: ${name} exceeds read limit`);
  }
}
async function readComplete(
  io: DeclarationReaderIO,
  path: string,
  name: string,
  initial: FileStamp,
): Promise<Buffer> {
  let file;
  try {
    file = await io.open(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw changed(name);
    throw error;
  }
  try {
    if (!sameFile(initial, await file.stat())) throw changed(name);
    // 单次 read 允许短读；必须循环至 EOF，并读取额外一字节检测增长，不能把前缀误当完整内容。
    const bytes = Buffer.alloc(initial.size + 1);
    let total = 0;
    while (true) {
      const { bytesRead } = await file.read(
        bytes,
        total,
        Math.min(64 * 1024, bytes.length - total),
        total,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > initial.size) throw changed(name);
    }
    if (total !== initial.size || !sameFile(initial, await file.stat())) throw changed(name);
    return bytes.subarray(0, total);
  } finally {
    await file.close();
  }
}

export function createDeclarationReader(
  io: DeclarationReaderIO = defaultIO,
): DeclarationReaderPort {
  return {
    async read(cwd) {
      // 先后两次核对整个声明集合，覆盖已读文件被替换/删除及原本不存在的配置被新增。
      const before = await Promise.all(FILE_NAMES.map((name) => statOptional(io, join(cwd, name))));
      for (const [index, name] of FILE_NAMES.entries()) {
        const stamp = before[index];
        if (stamp) checkLimit(name, stamp);
      }
      const text: Record<string, string> = {};
      const lockfileDigests: Record<string, string> = {};
      const configurationDigests: Record<string, string> = {};
      // 顺序读取并立即哈希锁/配置，不并行持有多个 32 MiB 锁文件，也不把配置原文交给 domain。
      for (const [index, name] of FILE_NAMES.entries()) {
        const stamp = before[index];
        if (!stamp) continue;
        const bytes = await readComplete(io, join(cwd, name), name, stamp);
        if (KNOWN_LOCKFILES.includes(name)) lockfileDigests[name] = sha(bytes);
        else if (CONFIGURATION_FILES.some((entry) => entry === name))
          configurationDigests[name] = sha(bytes);
        else text[name] = bytes.toString("utf8");
      }
      const after = await Promise.all(FILE_NAMES.map((name) => statOptional(io, join(cwd, name))));
      for (const [index, name] of FILE_NAMES.entries()) {
        if (!sameFile(before[index], after[index])) throw changed(name);
      }
      return parseProjectDeclarations({
        miseToml: text["mise.toml"],
        nodeVersionFile: text[".node-version"],
        nvmrcFile: text[".nvmrc"],
        packageJson: text["package.json"],
        lockfileNames: Object.keys(lockfileDigests),
        lockfileDigests,
        configurationDigests,
      });
    },
  };
}
