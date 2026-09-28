import { constants, accessSync, existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { BrowserType, ChromiumBrowser } from "playwright-core";

export interface BrowserExecutableResolutionOptions {
  env?: NodeJS.ProcessEnv;
  executablePath?: string;
  platform?: NodeJS.Platform | string;
}

export interface PlaywrightChromiumModule {
  chromium: BrowserType<ChromiumBrowser>;
}

const LINUX_BROWSER_PATHS = [
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
];

const MAC_BROWSER_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

function windowsBrowserPaths(env: NodeJS.ProcessEnv): string[] {
  return [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]
    .filter((root): root is string => Boolean(root?.trim()))
    .flatMap((root) => [
      join(root, "Google", "Chrome", "Application", "chrome.exe"),
      join(root, "Chromium", "Application", "chrome.exe"),
      join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
    ]);
}

function isUsableExecutable(path: string, platform: NodeJS.Platform | string): boolean {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return false;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function validateExplicitBrowserExecutable(
  path: string | undefined,
  platform: NodeJS.Platform | string = process.platform,
): string | undefined {
  if (path === undefined) return undefined;
  if (!isAbsolute(path)) {
    throw new Error(`Browser executable path must be absolute: ${path}`);
  }
  const absolutePath = path;
  if (!isUsableExecutable(absolutePath, platform)) {
    throw new Error(`Browser executable is missing or not executable: ${absolutePath}`);
  }
  return absolutePath;
}

export function resolveInstalledBrowserExecutable(
  playwright: PlaywrightChromiumModule,
  options: BrowserExecutableResolutionOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const explicit = validateExplicitBrowserExecutable(options.executablePath, platform);
  if (explicit) return explicit;

  const playwrightPath = playwright.chromium.executablePath();
  const candidates = [
    ...(playwrightPath ? [playwrightPath] : []),
    ...(platform === "darwin"
      ? MAC_BROWSER_PATHS
      : platform === "win32"
        ? windowsBrowserPaths(options.env ?? process.env)
        : LINUX_BROWSER_PATHS),
  ];
  const resolved = candidates.find((candidate) => isUsableExecutable(candidate, platform));
  if (resolved) return resolved;

  throw new Error(
    "No installed Chrome or Chromium executable was found. " +
      "Install Chromium or pass --browser-executable <absolute-path>.",
  );
}

export async function loadPlaywrightChromium(): Promise<PlaywrightChromiumModule> {
  // 延迟加载很关键：Desktop/app-server 路径不会启用 CLI headless，不能因外置依赖缺失而启动失败。
  return (await import("playwright-core")) as PlaywrightChromiumModule;
}
