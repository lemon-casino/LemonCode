import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  parseProjectDeclarations,
  type DeclarationInputs,
  type ProjectDeclarations,
} from "../domain/declarations.js";
import type { DeclarationReaderPort } from "../app/ports.js";

/**
 * 声明读取适配器：文件系统 IO 集中在这一个文件（app/domain 不触盘）。
 * 异步 IO；缺失文件返回 undefined 交由解析器判断"无声明"。
 */

const LOCKFILE_CANDIDATES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
];

async function readOptional(dir: string, name: string): Promise<string | undefined> {
  try {
    return await readFile(join(dir, name), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function findLockfiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of LOCKFILE_CANDIDATES) {
    try {
      await stat(join(dir, name));
      found.push(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return found;
}

export function createDeclarationReader(): DeclarationReaderPort {
  return {
    async read(cwd: string): Promise<ProjectDeclarations> {
      const inputs: DeclarationInputs = {
        miseToml: await readOptional(cwd, "mise.toml"),
        nodeVersionFile: await readOptional(cwd, ".node-version"),
        nvmrcFile: await readOptional(cwd, ".nvmrc"),
        packageJson: await readOptional(cwd, "package.json"),
        lockfileNames: await findLockfiles(cwd),
      };
      return parseProjectDeclarations(inputs);
    },
  };
}
