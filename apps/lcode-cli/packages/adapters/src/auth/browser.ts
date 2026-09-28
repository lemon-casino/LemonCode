import { spawn, type ChildProcess } from "node:child_process";

const BROWSER_OPEN_SETTLE_TIMEOUT_MS = 1_000;

export interface BrowserOpenResult {
  command: string;
  opened: boolean;
  reason?: string;
}

export interface BrowserOpenOptions {
  platform?: NodeJS.Platform;
  spawnProcess?: typeof spawn;
  timeoutMs?: number;
}

export async function openUrlInBrowser(
  url: string,
  options: BrowserOpenOptions = {},
): Promise<BrowserOpenResult> {
  const platform = options.platform ?? process.platform;
  const command = browserOpenCommand(platform, url);
  const spawnProcess = options.spawnProcess ?? spawn;

  try {
    const child = spawnProcess(command.executable, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    return await waitForBrowserSpawn(child, command.executable, options.timeoutMs);
  } catch (error) {
    return {
      command: command.executable,
      opened: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function browserOpenCommand(
  platform: NodeJS.Platform,
  url: string,
): { args: string[]; executable: string } {
  if (platform === "darwin") {
    return { executable: "open", args: [url] };
  }

  if (platform === "win32") {
    return { executable: "cmd.exe", args: ["/c", "start", "", url] };
  }

  return { executable: "xdg-open", args: [url] };
}

function waitForBrowserSpawn(
  child: ChildProcess,
  command: string,
  timeoutMs = BROWSER_OPEN_SETTLE_TIMEOUT_MS,
): Promise<BrowserOpenResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const settle = (result: BrowserOpenResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeAllListeners("error");
      child.removeAllListeners("spawn");
      if (result.opened) {
        child.unref();
      }
      resolve(result);
    };
    timeout = setTimeout(() => {
      settle({ command, opened: true });
    }, timeoutMs);

    child.once("spawn", () => {
      settle({ command, opened: true });
    });
    child.once("error", (error) => {
      settle({
        command,
        opened: false,
        reason: error.message,
      });
    });
  });
}
