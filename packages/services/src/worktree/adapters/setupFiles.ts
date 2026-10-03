import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WorktreeGit } from "../app/ports.js";

const MAX_FILES = 10_000;
const MAX_BYTES = 64 * 1024 * 1024;

export function createSetupFileCopier(git: WorktreeGit) {
  return async (sourceRoot: string, checkout: string, paths: string[]) => {
    const files: { source: string; target: string; size: number }[] = [];
    let total = 0;
    async function collect(source: string, target: string) {
      const stat = await lstat(source);
      if (stat.isSymbolicLink())
        throw new Error("Setup copy does not follow symbolic links or junctions");
      if (stat.isDirectory()) {
        for (const child of await readdir(source))
          await collect(join(source, child), join(target, child));
      } else if (stat.isFile()) {
        total += stat.size;
        if (files.length >= MAX_FILES || total > MAX_BYTES)
          throw new Error("Setup copy exceeds 10,000 files or 64 MiB; no files were copied");
        files.push({ source, target, size: stat.size });
      } else throw new Error("Setup copy only supports ordinary files and directories");
    }
    for (const path of paths) {
      const source = resolve(sourceRoot, path);
      const child = relative(sourceRoot, source);
      if (
        !child ||
        isAbsolute(path) ||
        child === ".." ||
        child.startsWith(`..${sep}`) ||
        isAbsolute(child) ||
        child.split(sep).includes(".git")
      )
        throw new Error(
          "Setup copy path must be repository-relative and inside the source repository",
        );
      for (let at = source; at !== sourceRoot; at = dirname(at)) {
        if ((await lstat(at)).isSymbolicLink())
          throw new Error("Setup source path has a symbolic link or junction");
      }
      const ignored = await git.run({
        cwd: sourceRoot,
        args: ["check-ignore", "--quiet", "--", child],
      });
      if (ignored.exitCode !== 0)
        throw new Error("Setup copy allowlist may only contain ignored files");
      await collect(source, resolve(checkout, child));
    }
    for (const file of files) {
      const parents: string[] = [];
      for (let parent = dirname(file.target); parent !== checkout; parent = dirname(parent))
        parents.unshift(parent);
      for (const parent of parents) {
        try {
          await mkdir(parent);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        if ((await lstat(parent)).isSymbolicLink())
          throw new Error("Setup destination has a symbolic link or junction");
      }
      const content = await readFile(file.source);
      if (content.length !== file.size) throw new Error("Setup source changed during copying");
      try {
        await writeFile(file.target, content, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (
          (await lstat(file.target)).isSymbolicLink() ||
          !content.equals(await readFile(file.target))
        )
          throw new Error("Setup destination already has different content");
      }
    }
  };
}
