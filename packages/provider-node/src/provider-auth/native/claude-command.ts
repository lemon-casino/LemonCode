import { open, readFile, stat } from "node:fs/promises";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { record, text } from "./common.js";

interface Options {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  nodeExecutable?: string;
  cwd?: string;
}
export interface ClaudeCommand {
  command: string;
  prefix: string[];
  node: boolean;
}
const dependencyError = () =>
  new Error(
    "Claude Code CLI is required; install its native executable or set LCODE_CLAUDE_BIN to Claude's executable or CLI JavaScript",
  );
async function file(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
const script = (path: string) => /\.(?:mjs|cjs|js)$/i.test(path);

/** Resolve npm shims as data. Their shell commands, variables and prompt arguments are never evaluated. */
async function npmScript(shim: string): Promise<string | undefined> {
  let contents = "";
  try {
    contents = await readFile(shim, "utf8");
  } catch {
    return;
  }
  if (contents.length > 65_536) return;
  const candidates: string[] = [];
  for (const match of contents.matchAll(/(?:%dp0%|%~dp0)[\\/]([^"\r\n]*\.(?:js|cjs|mjs))/gi)) {
    const suffix = match[1];
    if (suffix && !/[%$]/.test(suffix) && /@anthropic-ai[\\/]claude-code[\\/]/.test(suffix))
      candidates.push(resolve(dirname(shim), ...suffix.split(/[\\/]/)));
  }
  // npm's global shim is beside node_modules; local installs put it in node_modules/.bin.
  for (const directory of [
    join(dirname(shim), "node_modules", "@anthropic-ai", "claude-code"),
    resolve(dirname(shim), "..", "@anthropic-ai", "claude-code"),
  ]) {
    try {
      const pkg = record(JSON.parse(await readFile(join(directory, "package.json"), "utf8")));
      const bin = typeof pkg.bin === "string" ? pkg.bin : text(record(pkg.bin).claude);
      if (bin && script(bin)) candidates.push(resolve(directory, bin));
    } catch {
      /* Continue to another known npm package layout. */
    }
  }
  for (const candidate of candidates) if (await file(candidate)) return candidate;
}

export async function resolveClaudeCommand(options: Options = {}): Promise<ClaudeCommand> {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const configured = environment.LCODE_CLAUDE_BIN?.trim();
  const name = configured || "claude";
  const path = Object.entries(environment).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
  const directories = path
    .split(platform === "win32" ? ";" : delimiter)
    .filter(Boolean)
    .map((value) => value.replace(/^"|"$/g, ""));
  const explicit = isAbsolute(name) || /[\\/]/.test(name);
  const candidates = explicit
    ? [resolve(options.cwd ?? process.cwd(), name)]
    : directories.map((directory) => join(directory, name));
  if (platform === "win32") {
    // Prefer a native installation even if an older npm shim appears earlier in PATH.
    for (const candidate of candidates) {
      const native = /\.(?:cmd|bat|exe)$/i.test(candidate)
        ? candidate.replace(/\.(?:cmd|bat|exe)$/i, ".exe")
        : candidate + ".exe";
      if (await file(native)) return { command: native, prefix: [], node: false };
    }
    for (const candidate of candidates) {
      if (script(candidate) && (await file(candidate)))
        return { command: nodeExecutable, prefix: [candidate], node: true };
      const shim = /\.(?:cmd|bat)$/i.test(candidate) ? candidate : candidate + ".cmd";
      const entry = await npmScript(shim);
      if (entry) return { command: nodeExecutable, prefix: [entry], node: true };
    }
  } else {
    for (const candidate of candidates) {
      if (!(await file(candidate))) continue;
      let node = script(candidate);
      if (!node && !extname(candidate)) {
        const handle = await open(candidate, "r");
        try {
          const buffer = Buffer.alloc(160);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          node = /^#![^\n]*\bnode\b/.test(buffer.toString("utf8", 0, bytesRead));
        } finally {
          await handle.close();
        }
      }
      return node
        ? { command: nodeExecutable, prefix: [candidate], node: true }
        : { command: candidate, prefix: [], node: false };
    }
  }
  throw dependencyError();
}
