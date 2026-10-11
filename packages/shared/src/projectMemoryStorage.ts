import { createHash } from "node:crypto";
import { lstat, opendir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isRemoteWorkspaceIdentity } from "./remote-workspace-identity.js";
import { withFileLock } from "./node/privateFilePersistence.js";
import {
  localMemoryStoragePath,
  memoryStorageErrorCode,
  MemoryStorageDirectories,
  ProjectMemoryStorageError,
  readMemoryStorageFile,
  publishMemoryStorageFile,
} from "./node/projectMemoryStorageIO.js";
export { ProjectMemoryStorageError } from "./node/projectMemoryStorageIO.js";

export type ProjectMemoryStorageLocation = "profile" | "workspace";
export interface ProjectMemoryStorageInput {
  cliStorageRoot: string;
  workspaceIdentity?: string;
  workspacePath: string;
  storageLocation?: ProjectMemoryStorageLocation;
  storageRevision?: number;
}

function assertLocation(location: unknown): asserts location is ProjectMemoryStorageLocation {
  if (location !== "profile" && location !== "workspace")
    throw new ProjectMemoryStorageError("invalid_marker");
}
function workspaceKey(input: ProjectMemoryStorageInput): string {
  const path = resolve(input.workspacePath);
  return (
    input.workspaceIdentity?.trim() || (process.platform === "win32" ? path.toLowerCase() : path)
  );
}

export function resolveProjectMemoryRoot(input: ProjectMemoryStorageInput): string {
  const location = input.storageLocation ?? "profile";
  assertLocation(location);
  if (location === "workspace") {
    const identity = input.workspaceIdentity?.trim();
    if (isRemoteWorkspaceIdentity(identity ?? ""))
      throw new ProjectMemoryStorageError("unsupported_scope");
    const projectRoot = localMemoryStoragePath(input.workspacePath);
    // 原因：同物理路径的本地project identity仍是不同scope，不能共用一份项目内记忆。
    return identity
      ? join(
          projectRoot,
          ".lcode",
          "memories",
          createHash("sha256").update(identity).digest("hex").slice(0, 16),
          "memory",
        )
      : join(projectRoot, ".lcode", "memory");
  }
  const path = resolve(input.workspacePath);
  const hash = createHash("sha256").update(workspaceKey(input)).digest("hex").slice(0, 16);
  const slug = input.workspaceIdentity?.trim()
    ? "project"
    : basename(path)
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/gu, "-")
        .replace(/^-+|-+$/gu, "")
        .slice(0, 48) || "project";
  return join(input.cliStorageRoot, "memories", "projects", `${slug}-${hash}`, "memory");
}

const FILE_LIMIT = 256;
const SCAN_LIMIT = 1024;
const DEPTH_LIMIT = 8;
const FILE_BYTES = 256 * 1024;
const TOTAL_BYTES = 16 * 1024 * 1024;
const MARKER_BYTES = 4096;
type LocationMarker = {
  workspaceKey: string;
  location: ProjectMemoryStorageLocation;
} & ({ schemaVersion: 1 } | { schemaVersion: 2; storageRevision: number });

function assertStorageRevision(revision: number | undefined): void {
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0))
    throw new ProjectMemoryStorageError("invalid_marker");
}

function isOlderPreparation(
  marker: LocationMarker | undefined,
  revision: number | undefined,
): boolean {
  return (
    marker?.schemaVersion === 2 && (revision === undefined || revision < marker.storageRevision)
  );
}

async function readMarker(
  path: string,
  key: string,
  directories: MemoryStorageDirectories,
): Promise<LocationMarker | undefined> {
  const bytes = await readMemoryStorageFile(path, MARKER_BYTES, directories);
  if (!bytes) return undefined;
  let marker;
  try {
    marker = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ProjectMemoryStorageError("invalid_marker");
  }
  if (
    !marker ||
    typeof marker !== "object" ||
    ![1, 2].includes(marker.schemaVersion) ||
    Object.keys(marker).length !== (marker.schemaVersion === 1 ? 3 : 4) ||
    marker.workspaceKey !== key
  )
    throw new ProjectMemoryStorageError("invalid_marker");
  assertLocation(marker.location);
  if (marker.schemaVersion === 2) {
    if (typeof marker.storageRevision !== "number")
      throw new ProjectMemoryStorageError("invalid_marker");
    assertStorageRevision(marker.storageRevision);
  }
  return marker;
}

async function sourceFiles(
  rootDir: string,
  directories: MemoryStorageDirectories,
): Promise<Array<{ name: string; bytes: Buffer }>> {
  const files: Array<{ name: string; bytes: Buffer }> = [];
  let scanned = 0;
  let totalBytes = 0;
  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    await directories.chain(directory);
    const stream = await opendir(directory);
    for await (const entry of stream) {
      if (++scanned > SCAN_LIMIT) throw new ProjectMemoryStorageError("budget_exceeded");
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new ProjectMemoryStorageError("invalid_path");
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (info.isDirectory()) {
        if (depth >= DEPTH_LIMIT) throw new ProjectMemoryStorageError("budget_exceeded");
        await walk(path, name, depth + 1);
      } else if (entry.name.endsWith(".md")) {
        if (
          !info.isFile() ||
          name.length > 240 ||
          name
            .split("/")
            .some(
              (part) =>
                /[. ]$|[<>:"|?*\\]/u.test(part) ||
                [...part].some((char) => char.charCodeAt(0) < 32) ||
                /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
            )
        )
          throw new ProjectMemoryStorageError("invalid_path");
        if (files.length >= FILE_LIMIT) throw new ProjectMemoryStorageError("budget_exceeded");
        const bytes = await readMemoryStorageFile(path, FILE_BYTES, directories);
        if (!bytes) throw new ProjectMemoryStorageError("invalid_path");
        if ((totalBytes += bytes.length) > TOTAL_BYTES)
          throw new ProjectMemoryStorageError("budget_exceeded");
        files.push({ name, bytes });
      }
    }
  };
  await walk(rootDir, "", 0);
  return files.sort((left, right) => left.name.localeCompare(right.name));
}

export async function prepareProjectMemoryStorage(
  input: ProjectMemoryStorageInput & {
    storageLocation: ProjectMemoryStorageLocation;
    previousStorageLocation?: ProjectMemoryStorageLocation;
  },
): Promise<{ rootDir: string; copiedCount: number; conflictCount: number }> {
  assertLocation(input.storageLocation);
  assertStorageRevision(input.storageRevision);
  if (input.previousStorageLocation !== undefined) assertLocation(input.previousStorageLocation);
  const rootDir = resolveProjectMemoryRoot(input);
  const profile = localMemoryStoragePath(
    resolveProjectMemoryRoot({ ...input, storageLocation: "profile" }),
  );
  const key = workspaceKey(input);
  if (Buffer.byteLength(key, "utf8") > 2048) throw new ProjectMemoryStorageError("invalid_marker");
  const directories = new MemoryStorageDirectories();
  await directories.chain(profile, true);
  await directories.chain(join(dirname(profile), "memory-state"), true);
  const markerPath = join(dirname(profile), "storage-location.json");
  const initial = await readMarker(markerPath, key, directories);
  let needsWorkspace =
    input.storageLocation === "workspace" ||
    (!isOlderPreparation(initial, input.storageRevision) &&
      (initial?.location === "workspace" || input.previousStorageLocation === "workspace"));

  // 原因：设置命令和首次 Runtime 初始化可并发；profile writer 锁同时串行迁移标记。
  // 初读marker过期时至多重新取得一次双根锁，绝不逆序追加锁或无限重试。
  for (let attempt = 0; attempt < 2; attempt++) {
    const workspace = needsWorkspace
      ? resolveProjectMemoryRoot({ ...input, storageLocation: "workspace" })
      : undefined;
    if (workspace) {
      const contained = (left: string, right: string) => {
        const value = relative(left, right);
        return !isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`);
      };
      if (
        contained(profile, workspace) ||
        contained(workspace, profile) ||
        contained(join(dirname(profile), "memory-state"), workspace) ||
        contained(join(dirname(workspace), "memory-state"), profile)
      )
        throw new ProjectMemoryStorageError("invalid_path");
    }
    const roots = [profile, ...(workspace ? [workspace] : [])];
    for (const root of roots) {
      await directories.chain(root, true);
      await directories.chain(join(dirname(root), "memory-state"), true);
    }
    const locks = [
      ...new Set(roots.map((root) => join(dirname(root), "memory-state", "writer"))),
    ].sort((left, right) =>
      process.platform === "win32"
        ? left.toLowerCase().localeCompare(right.toLowerCase())
        : left.localeCompare(right),
    );
    const lock = async <T>(index: number, operation: () => Promise<T>): Promise<T> => {
      if (index === locks.length) return operation();
      await directories.validate();
      try {
        const info = await lstat(`${locks[index]!}.lock`);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new ProjectMemoryStorageError("invalid_path");
      } catch (error) {
        if (memoryStorageErrorCode(error) !== "ENOENT") throw error;
      }
      return withFileLock(locks[index]!, () => lock(index + 1, operation));
    };
    const result = await lock(0, async () => {
      await directories.validate();
      for (const path of locks) {
        const info = await lstat(`${path}.lock`);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new ProjectMemoryStorageError("invalid_path");
      }
      const marker = await readMarker(markerPath, key, directories);
      // 原因：旧Runtime可在设置切换后才首次初始化；锁只提供串行顺序，不代表配置新旧。
      // 旧版本只使用其冻结根，不能反向复制/回退marker并复活新位置已删除的文件。
      if (isOlderPreparation(marker, input.storageRevision)) {
        if (input.previousStorageLocation !== undefined)
          throw new ProjectMemoryStorageError("revision_conflict");
        return { rootDir, copiedCount: 0, conflictCount: 0 };
      }
      if (
        marker?.schemaVersion === 2 &&
        marker.storageRevision === input.storageRevision &&
        marker.location !== input.storageLocation
      )
        throw new ProjectMemoryStorageError("revision_conflict");
      if (!workspace && marker?.location === "workspace") return undefined;
      let copiedCount = 0;
      let conflictCount = 0;
      const explicitSwitch =
        input.previousStorageLocation !== undefined &&
        input.previousStorageLocation !== input.storageLocation;
      const versionChanged =
        input.storageRevision !== undefined &&
        (marker?.schemaVersion !== 2 || marker.storageRevision !== input.storageRevision);
      if (marker?.location !== input.storageLocation || explicitSwitch || versionChanged) {
        // 原因：copy后setting提交可能失败，marker不能替代SettingService的权威旧位置；
        // 显式重试必须补齐旧位置期间新增文件，Runtime无previous仍保持不复活删除文件。
        const previous = input.previousStorageLocation ?? marker?.location ?? "profile";
        if (previous !== input.storageLocation) {
          const source = previous === "profile" ? profile : workspace!;
          // 先冻结并验证所有源文件及总预算，再写任何目标文件。
          const files = await sourceFiles(source, directories);
          for (const file of files) {
            const target = join(rootDir, ...file.name.split("/"));
            await directories.chain(dirname(target), true);
            let current = await readMemoryStorageFile(target, FILE_BYTES, directories);
            if (!current && (await publishMemoryStorageFile(target, file.bytes, directories)))
              copiedCount++;
            else {
              current ??= await readMemoryStorageFile(target, FILE_BYTES, directories);
              if (!current || !current.equals(file.bytes)) conflictCount++;
            }
          }
        }
        const next: LocationMarker = {
          workspaceKey: key,
          location: input.storageLocation,
          ...(input.storageRevision === undefined
            ? { schemaVersion: 1 as const }
            : { schemaVersion: 2 as const, storageRevision: input.storageRevision }),
        };
        // 原因：固定staging名在崩溃后会永久阻断重试；随机临时文件原子替换同一marker。
        if (
          !(await publishMemoryStorageFile(
            markerPath,
            Buffer.from(JSON.stringify(next)),
            directories,
            Boolean(marker),
          ))
        )
          throw new ProjectMemoryStorageError("invalid_marker");
      }
      return { rootDir, copiedCount, conflictCount };
    });
    if (result) return result;
    needsWorkspace = true;
  }
  throw new ProjectMemoryStorageError("invalid_marker");
}
