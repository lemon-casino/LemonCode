export type InstalledAppLauncherErrorCode =
  | "APP_NOT_FOUND"
  | "AMBIGUOUS_APP"
  | "LAUNCH_FAILED"
  | "CONTROL_STOPPED";

export declare class InstalledAppLauncherError extends Error {
  constructor(
    code: InstalledAppLauncherErrorCode,
    message: string,
    options?: { cause?: unknown; details?: unknown },
  );
  readonly code: InstalledAppLauncherErrorCode;
  readonly details?: unknown;
}

export interface InstalledAppReference {
  name?: string;
  bundle_id?: string;
}

export interface InstalledAppRecord {
  name?: string;
  bundleId?: string;
  appId?: string;
  desktopId?: string;
  executable?: string;
  path?: string;
}

export interface InstalledAppLauncherCommand {
  file: string;
  args: string[];
  cwd?: string;
  signal: AbortSignal;
  waitForExit?: boolean;
}

export interface InstalledAppLauncher {
  resolve(ref: InstalledAppReference): Promise<InstalledAppRecord>;
  launch(ref: InstalledAppReference): Promise<InstalledAppRecord>;
  dispose(): Promise<void>;
}

export interface InstalledAppLauncherOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: (command: InstalledAppLauncherCommand) => Promise<{ stdout: string; stderr: string }>;
}

export declare function normalizeInstalledAppName(value: string): string;
export declare function normalizeInstalledAppLookupKey(
  ref: InstalledAppReference,
  platform?: NodeJS.Platform,
): string;
export declare function createInstalledAppLauncher(
  options?: InstalledAppLauncherOptions,
): InstalledAppLauncher;
