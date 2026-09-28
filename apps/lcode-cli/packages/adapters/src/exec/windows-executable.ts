import { extname, win32 } from "node:path";

const DEFAULT_WINDOWS_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD"];

export function getWindowsEnvValue(
  env: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  const lowerKey = key.toLowerCase();
  const match = Object.keys(env).find((envKey) => envKey.toLowerCase() === lowerKey);
  return match ? env[match] : undefined;
}

export function windowsExecutableCandidates(
  file: string,
  env: NodeJS.ProcessEnv,
  cwd?: string,
): string[] {
  const pathExts = getWindowsPathExts(env);
  const fileCandidates = windowsExtensionCandidates(file, pathExts);

  if (hasWindowsPathSeparator(file) || win32.isAbsolute(file)) {
    const basePath =
      !win32.isAbsolute(file) && cwd ? win32.resolve(cwd, file) : win32.normalize(file);
    return windowsExtensionCandidates(basePath, pathExts);
  }

  const dirs =
    getWindowsEnvValue(env, "PATH")
      ?.split(win32.delimiter)
      .filter((dir) => dir.length > 0) ?? [];
  return dirs.flatMap((dir) => fileCandidates.map((candidate) => win32.join(dir, candidate)));
}

function windowsExtensionCandidates(file: string, pathExts: string[]): string[] {
  if (extname(file)) return [file];
  return [file, ...pathExts.map((extension) => `${file}${extension.toLowerCase()}`)];
}

function getWindowsPathExts(env: NodeJS.ProcessEnv): string[] {
  const raw = getWindowsEnvValue(env, "PATHEXT");
  const values = raw
    ?.split(";")
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0);
  return values && values.length > 0 ? values : DEFAULT_WINDOWS_PATHEXT;
}

function hasWindowsPathSeparator(value: string): boolean {
  return value.includes("\\") || value.includes("/");
}
