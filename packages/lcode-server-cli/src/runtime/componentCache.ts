import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep, win32 } from "node:path";
import { pipeline } from "node:stream/promises";
import { open as openZip, type Entry, type ZipFile } from "yauzl";
import type { ServerRuntimeManifest } from "./manifest.js";
import { promoteImmutableReleaseDirectory } from "./immutableRelease.js";
import type { ServerLayout } from "./paths.js";

function assertComponentId(componentId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(componentId)) {
    throw new Error(`Invalid component id: ${componentId}`);
  }
}

function assertSha256(sha256: string): void {
  if (!/^[a-f0-9]{64}$/iu.test(sha256)) throw new Error(`Invalid component SHA-256: ${sha256}`);
}

function safeRelativePath(pathValue: string): string {
  if (
    !pathValue ||
    pathValue.includes("\0") ||
    isAbsolute(pathValue) ||
    win32.isAbsolute(pathValue)
  ) {
    throw new Error(`Unsafe component path: ${pathValue}`);
  }
  const normalized = pathValue.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".."))
    throw new Error(`Unsafe component path: ${pathValue}`);
  return normalized;
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = entry.name;
    const absolutePath = join(root, relativePath);
    if (entry.isDirectory()) {
      for (const nested of await listFiles(absolutePath)) files.push(join(relativePath, nested));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else if (entry.isSymbolicLink()) {
      throw new Error(`Component contains unsupported symbolic link: ${relativePath}`);
    }
  }
  return files.sort();
}

async function hashPaths(root: string, paths: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const rawPath of [...paths].sort()) {
    const relativePath = safeRelativePath(rawPath);
    const absolutePath = join(root, ...relativePath.split("/"));
    const pathStat = await stat(absolutePath);
    const files = pathStat.isDirectory()
      ? (await listFiles(absolutePath)).map((file) => join(relativePath, file))
      : [relativePath];
    for (const file of files.sort()) {
      const normalizedFile = file.split(sep).join("/");
      hash.update(`${normalizedFile}\0`);
      hash.update(await readFile(join(root, ...normalizedFile.split("/"))));
    }
  }
  return hash.digest("hex");
}

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
  captureOutput = false,
): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise(captureOutput ? stdout : "");
      else rejectPromise(new Error(`${command} failed (${code}): ${stderr}`));
    });
  });
}

function validateArchiveEntries(listing: string): void {
  for (const rawEntry of listing.split(/\r?\n/u)) {
    const entry = rawEntry.trim().replace(/\/$/u, "");
    if (!entry || entry === ".") continue;
    safeRelativePath(entry.replace(/^\.\//u, ""));
  }
}

function openZipFile(archivePath: string): Promise<ZipFile> {
  return new Promise((resolvePromise, rejectPromise) => {
    openZip(
      archivePath,
      { autoClose: false, lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, zip) => (error ? rejectPromise(error) : resolvePromise(zip)),
    );
  });
}

function openZipEntry(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolvePromise, rejectPromise) => {
    zip.openReadStream(entry, (error, stream) =>
      error ? rejectPromise(error) : resolvePromise(stream),
    );
  });
}

function isZipSymlink(entry: Entry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (unixMode & 0o170000) === 0o120000;
}

async function extractZipSafely(archivePath: string, destination: string): Promise<void> {
  const zip = await openZipFile(archivePath);
  const seen = new Set<string>();
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        rejectPromise(error);
      };
      zip.once("error", fail);
      zip.once("end", () => {
        if (settled) return;
        settled = true;
        resolvePromise();
      });
      zip.on("entry", (entry: Entry) => {
        void (async () => {
          const relativePath = safeRelativePath(entry.fileName).replace(/\/$/u, "");
          if (!relativePath) {
            zip.readEntry();
            return;
          }
          if (seen.has(relativePath))
            throw new Error(`Component archive contains duplicate entry: ${relativePath}`);
          seen.add(relativePath);
          if (isZipSymlink(entry))
            throw new Error(`Component archive contains a symbolic link: ${relativePath}`);
          const outputPath = join(destination, ...relativePath.split("/"));
          if (entry.fileName.endsWith("/")) {
            await mkdir(outputPath, { recursive: true });
          } else {
            await mkdir(dirname(outputPath), { recursive: true });
            const input = await openZipEntry(zip, entry);
            await pipeline(input, createWriteStream(outputPath, { mode: 0o600 }));
          }
          zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}

export async function extractArchiveSafely(
  archivePath: string,
  destination: string,
): Promise<void> {
  const isZip = archivePath.toLowerCase().endsWith(".zip");
  if (isZip) {
    // macOS/Windows 自带 bsdtar 能读取 ZIP，GNU tar 不能；Linux 上用 tar 解 ZIP 会直接报错，
    // 单测与 Linux 控制端安装 Windows 归档因此稳定失败。ZIP 改走同进程解析并保留路径/链接校验。
    await extractZipSafely(archivePath, destination);
    return;
  }
  const listing = await run("tar", ["-tzf", archivePath], destination, true);
  const verboseListing = await run("tar", ["-tvzf", archivePath], destination, true);
  if (verboseListing.split(/\r?\n/u).some((line) => /^[lh]/u.test(line))) {
    throw new Error(`Component archive contains a symbolic or hard link: ${archivePath}`);
  }
  validateArchiveEntries(listing);
  await run("tar", ["-xzf", archivePath, "-C", destination], destination);
}

export class ComponentCache {
  public constructor(private readonly layout: ServerLayout) {}

  public path(target: string, componentId: string, sha256: string): string {
    assertComponentId(componentId);
    assertSha256(sha256);
    if (!/^(?:darwin|linux|win32)-(?:x64|arm64)$/u.test(target))
      throw new Error(`Invalid component target: ${target}`);
    return join(this.layout.componentsCacheDir, target, componentId, sha256.toLowerCase());
  }

  public async findArchive(options: {
    target: string;
    componentId: string;
    sha256: string;
    extension?: "zip" | "tar.gz";
  }): Promise<string | null> {
    const targetDir = this.path(options.target, options.componentId, options.sha256);
    const candidates = options.extension
      ? [join(targetDir, options.extension === "zip" ? "component.zip" : "component.tar.gz")]
      : [join(targetDir, "component.tar.gz"), join(targetDir, "component.zip")];
    for (const candidate of candidates) {
      const markerPath = join(dirname(candidate), "component.json");
      try {
        const marker = JSON.parse(await readFile(markerPath, "utf8")) as {
          archiveSha256?: string;
          componentId?: string;
          sha256?: string;
        };
        // 旧缓存只记录 component sha，无法判断归档内容是否被截断、覆盖或与该 sha
        // 不匹配；直接复用会在 assemble 失败后永久命中坏缓存。缺少归档 hash 的旧条目
        // 统一视为 miss，下一次下载会原子替换成可验证的新条目。
        if (
          marker.componentId !== options.componentId ||
          marker.sha256?.toLowerCase() !== options.sha256.toLowerCase() ||
          !marker.archiveSha256 ||
          !/^[a-f0-9]{64}$/iu.test(marker.archiveSha256)
        )
          continue;
        await stat(candidate);
        const archiveSha256 = createHash("sha256")
          .update(await readFile(candidate))
          .digest("hex");
        if (archiveSha256 !== marker.archiveSha256.toLowerCase()) continue;
        return candidate;
      } catch {
        // 半成品 cache entry is ignored and will be replaced by the downloader.
      }
    }
    return null;
  }

  public async putArchive(options: {
    target: string;
    componentId: string;
    sha256: string;
    archivePath: string;
    archiveSha256: string;
  }): Promise<string> {
    const targetDir = this.path(options.target, options.componentId, options.sha256);
    const destination = join(
      targetDir,
      options.archivePath.toLowerCase().endsWith(".zip") ? "component.zip" : "component.tar.gz",
    );
    await mkdir(targetDir, { recursive: true, mode: 0o700 });
    const temporaryArchive = `${destination}.tmp-${process.pid}-${Date.now()}`;
    await cp(options.archivePath, temporaryArchive);
    if (!/^[a-f0-9]{64}$/iu.test(options.archiveSha256)) {
      await rm(temporaryArchive, { force: true });
      throw new Error(`Invalid component archive SHA-256: ${options.archiveSha256}`);
    }
    const digest = createHash("sha256")
      .update(await readFile(temporaryArchive))
      .digest("hex");
    if (digest.toLowerCase() !== options.archiveSha256.toLowerCase()) {
      await rm(temporaryArchive, { force: true });
      throw new Error(
        `Component archive checksum mismatch: expected ${options.archiveSha256}, received ${digest}`,
      );
    }
    await rename(temporaryArchive, destination);
    const markerTemporary = join(targetDir, `component.json.tmp-${process.pid}-${Date.now()}`);
    await writeFile(
      markerTemporary,
      `${JSON.stringify({ archiveSha256: options.archiveSha256.toLowerCase(), componentId: options.componentId, sha256: options.sha256 }, null, 2)}\n`,
      "utf8",
    );
    await rename(markerTemporary, join(targetDir, "component.json"));
    return destination;
  }

  public async assemble(options: {
    target: string;
    archiveSha256: string;
    baseReleaseDir: string;
    releaseDir: string;
    runtimeManifest: ServerRuntimeManifest;
    baseComponents?: ServerRuntimeManifest["components"];
    changed: Array<{ componentId: string; sha256: string; archivePath: string }>;
  }): Promise<void> {
    const targetReleaseDir = resolve(options.releaseDir);
    if (targetReleaseDir === resolve(options.baseReleaseDir))
      throw new Error("Component assembly cannot replace the active release");
    const temporaryReleaseDir = `${targetReleaseDir}.incoming-${process.pid}-${randomUUID()}`;
    try {
      await cp(options.baseReleaseDir, temporaryReleaseDir, { recursive: true, dereference: true });
      const nextComponents = options.runtimeManifest.components ?? [];
      const changedIds = new Set(options.changed.map((component) => component.componentId));
      for (const previousComponent of options.baseComponents ?? []) {
        const nextComponent = nextComponents.find(
          (component) => component.id === previousComponent.id,
        );
        const pathsUnchanged = nextComponent
          ? previousComponent.paths.length === nextComponent.paths.length &&
            previousComponent.paths.every((path, index) => path === nextComponent.paths[index])
          : false;
        if (nextComponent && pathsUnchanged && !changedIds.has(previousComponent.id)) continue;
        for (const rawPath of previousComponent.paths) {
          const relativePath = safeRelativePath(rawPath);
          // 组件路径若已转移给新组件，保留它并交给新组件归档覆盖；正常 staging 中
          // 组件路径不重叠，但这个判断避免迁移期间误删另一组件的文件。
          const ownedByAnotherComponent = nextComponents.some(
            (component) =>
              component.id !== previousComponent.id && component.paths.includes(relativePath),
          );
          if (!ownedByAnotherComponent)
            await rm(join(temporaryReleaseDir, ...relativePath.split("/")), {
              recursive: true,
              force: true,
            });
        }
      }
      for (const component of options.changed) {
        assertComponentId(component.componentId);
        assertSha256(component.sha256);
        await extractArchiveSafely(component.archivePath, temporaryReleaseDir);
      }
      for (const component of options.runtimeManifest.components ?? []) {
        const actual = await hashPaths(temporaryReleaseDir, component.paths);
        if (actual.toLowerCase() !== component.sha256.toLowerCase()) {
          throw new Error(
            `Component content checksum mismatch: ${component.id}; expected ${component.sha256}, received ${actual}`,
          );
        }
      }
      await writeFile(
        join(temporaryReleaseDir, "manifest.json"),
        `${JSON.stringify(options.runtimeManifest, null, 2)}\n`,
        "utf8",
      );
      await mkdir(dirname(targetReleaseDir), { recursive: true, mode: 0o700 });
      await promoteImmutableReleaseDirectory({
        incomingDir: temporaryReleaseDir,
        targetDir: targetReleaseDir,
        identity: {
          archiveSha256: options.archiveSha256,
          target: options.runtimeManifest.target,
          version: options.runtimeManifest.appVersion,
        },
      });
    } catch (error) {
      await rm(temporaryReleaseDir, { recursive: true, force: true });
      throw error;
    }
  }
}
