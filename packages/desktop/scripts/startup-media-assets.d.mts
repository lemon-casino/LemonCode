export const STARTUP_MEDIA_FILES: readonly string[];
export const STARTUP_MEDIA_NOTICE_FILES: readonly string[];
export function startupMediaDirectory(desktopRoot: string): string;
export function readStartupMediaAssets(directory: string): Promise<Record<string, Buffer>>;
