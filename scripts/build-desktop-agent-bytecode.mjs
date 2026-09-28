import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const defaultEntryPath = join(repoRoot, "apps/lcode-cli/packages/cli/dist/lcode.cjs");
const runtimeSourcePath = join(import.meta.dirname, "desktop-agent-bytecode-runtime.cjs");
const compilerPath = join(import.meta.dirname, "compile-desktop-agent-bytecode.cjs");

async function publishImmutable(path, contents) {
  try {
    await writeFile(path, contents, { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!(await readFile(path)).equals(contents)) {
      throw new Error(`已有字节码资源损坏: ${path}`);
    }
  }
}

export async function buildDesktopAgentBytecode({
  entryPath = defaultEntryPath,
  electronPath = createRequire(import.meta.url)("electron"),
  env = process.env,
} = {}) {
  if (env.LCODE_E2E_COVERAGE === "1") throw new Error("coverage 构建不能启用字节码试验");
  const directory = dirname(entryPath);
  const temporary = join(directory, `.bytecode-${randomUUID()}`);
  const loaderPath = join(directory, "lcode.bytecode.cjs");
  try {
    const { stdout } = await execFileAsync(electronPath, [compilerPath, entryPath, temporary], {
      env: { ...env, ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "" },
      maxBuffer: 1024 * 1024,
    });
    const metadata = JSON.parse(stdout);
    const bytecodeFile = `lcode.bytecode-${metadata.bytecodeSha256}.jsc`;
    const bytecodePath = join(directory, bytecodeFile);
    const runtimeSource = await readFile(runtimeSourcePath);
    const runtimeHash = createHash("sha256").update(runtimeSource).digest("hex");
    const runtimeFile = `lcode.bytecode-runtime-${runtimeHash}.cjs`;
    metadata.bytecodeFile = bytecodeFile;
    metadata.sourceFile = basename(entryPath);
    // 先写不可变依赖，最后原子替换入口；失败时上次可用的加载器仍能找到自己的字节码。
    await publishImmutable(bytecodePath, await readFile(temporary));
    await publishImmutable(join(directory, runtimeFile), runtimeSource);
    const loader = `#!/usr/bin/env node\n"use strict";\nconst metadata = ${JSON.stringify(metadata)};\nrequire(${JSON.stringify(`./${runtimeFile}`)}).loadBytecode(metadata, module, require).catch(error => {\n  process.stderr.write(String(error.stack ?? error) + "\\n");\n  process.exitCode = 1;\n});\n`;
    await writeFile(`${temporary}.cjs`, loader, { mode: 0o755 });
    await rename(`${temporary}.cjs`, loaderPath);
    return { loaderPath, bytecodePath, metadata };
  } finally {
    await Promise.all([temporary, `${temporary}.cjs`].map((file) => rm(file, { force: true })));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const artifact = await buildDesktopAgentBytecode();
  console.log(JSON.stringify(artifact, null, 2));
}
