import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { ProjectMemoryFileSummary } from "./memory.js";

export function isMemoryNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function isMemoryFileName(name: string): boolean {
  return (
    name.length > 0 &&
    name.endsWith(".md") &&
    !name.includes("\\") &&
    name.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

export async function requireMemoryDirectoryChain(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const component of ["", ...relative(root, absolute).split(sep).filter(Boolean)]) {
    current = join(current, component);
    const stat = await lstat(current);
    // 项目模式新增外部根，必须核对整条祖先链，不能只校验最后的 memory 文件夹。
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      relative(await realpath(current), current) !== ""
    ) {
      throw new Error("Project Memory directory must be a regular directory without links");
    }
  }
}

export async function requireMemoryFile(root: string, name: string): Promise<string> {
  if (!isMemoryFileName(name)) throw new Error("Invalid Project Memory file name");
  await requireMemoryDirectoryChain(root);
  const segments = name.split("/");
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const entry = (await readdir(current, { withFileTypes: true })).find(
      (entry) => entry.name === segment,
    );
    if (!entry) await lstat(join(current, segment));
    if (
      !entry ||
      entry.isSymbolicLink() ||
      (index === segments.length - 1 ? !entry.isFile() : !entry.isDirectory())
    ) {
      throw new Error("Project Memory file name must match an existing regular file exactly");
    }
    current = join(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (index < segments.length - 1 && !stat.isDirectory())) {
      throw new Error("Project Memory path cannot contain links");
    }
  }
  const relativePath = relative(await realpath(root), await realpath(current));
  if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error("Project Memory file is outside its root");
  }
  return current;
}

export async function listMemoryFiles(root: string): Promise<ProjectMemoryFileSummary[]> {
  try {
    await requireMemoryDirectoryChain(root);
  } catch (error) {
    if (isMemoryNotFound(error)) return [];
    throw error;
  }
  const files: ProjectMemoryFileSummary[] = [];
  let scanned = 0;
  async function visit(directory: string, prefix: string, depth: number): Promise<void> {
    if (depth > 8) throw new Error("Project Memory catalog exceeds directory depth limit");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++scanned > 1024) throw new Error("Project Memory catalog exceeds entry limit");
      if (entry.isSymbolicLink()) continue;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await requireMemoryDirectoryChain(path);
        await visit(path, name, depth + 1);
      } else if (entry.isFile() && isMemoryFileName(name)) {
        try {
          const metadata = await lstat(await requireMemoryFile(root, name));
          files.push({
            name,
            path,
            kind: name === "MEMORY.md" ? "index" : "item",
            size: metadata.size,
            updatedAt: metadata.mtimeMs,
          });
        } catch (error) {
          if (!isMemoryNotFound(error)) throw error;
        }
        if (files.length > 256) throw new Error("Project Memory catalog exceeds file limit");
      }
    }
  }
  await visit(root, "", 0);
  return files.sort((left, right) =>
    left.kind !== right.kind
      ? left.kind === "index"
        ? -1
        : 1
      : left.name.localeCompare(right.name, "en"),
  );
}
