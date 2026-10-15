import { execFile } from "node:child_process";
import { readFile, open, rename, rm } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { resolveClaudeCommand } from "./claude-command.js";

export interface LocalIO {
  platform: NodeJS.Platform;
  home: string;
  environment: NodeJS.ProcessEnv;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  run(
    command: string,
    args: string[],
    signal?: AbortSignal,
    environment?: NodeJS.ProcessEnv,
  ): Promise<string>;
  wslHomes?(): Promise<readonly string[]>;
}
const execute = promisify(execFile);
export const defaultLocalIO: LocalIO = {
  platform: process.platform,
  home: homedir(),
  environment: process.env,
  read: (path) => readFile(path, "utf8"),
  async write(path, content) {
    const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(content, "utf8");
      await file.sync();
      await file.close();
      // 同目录原子替换；失败保留旧授权文件，只删除本次创建的临时文件。
      await rename(temporary, path);
    } finally {
      await file.close();
      await rm(temporary, { force: true });
    }
  },
  async run(command, args, signal, environment) {
    const cli = command === "claude" ? await resolveClaudeCommand() : undefined;
    const output = await execute(cli?.command || command, [...(cli?.prefix || []), ...args], {
      windowsHide: true,
      shell: false,
      timeout: 15_000,
      maxBuffer: 262144,
      signal,
      encoding: "utf8",
      env: { ...process.env, ...environment, ...(cli?.node ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
    });
    return output.stdout;
  },
  async wslHomes() {
    if (process.platform !== "win32") return [];
    const names = (await defaultLocalIO.run("wsl.exe", ["--list", "--running", "--quiet"]))
      .replaceAll("\u0000", "")
      .split(/\r?\n/u)
      .map((x) => x.trim())
      .filter(Boolean);
    const homes: string[] = [];
    for (const name of names) {
      if (/[\\/]/u.test(name)) continue;
      try {
        const path = (
          await defaultLocalIO.run("wsl.exe", ["-d", name, "--", "sh", "-c", 'printf "%s" "$HOME"'])
        ).trim();
        if (path.startsWith("/") && !path.includes(".."))
          homes.push(`\\\\wsl.localhost\\${name}${path.replaceAll("/", "\\")}`);
      } catch {
        /* A distro that stopped while listed must not block native discovery. */
      }
    }
    return homes;
  },
};
