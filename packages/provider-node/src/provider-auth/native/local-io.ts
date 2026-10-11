import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
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
  write: (path, content) => writeFile(path, content, { mode: 0o600 }),
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
