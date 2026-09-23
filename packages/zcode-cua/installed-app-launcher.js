/* eslint-disable max-lines -- 三个平台的受信安装发现与启动参数必须共用同一 fail-closed 入口。 */
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, win32 as windowsPath } from "node:path";

const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
const WINDOWS_LAUNCHER_SUFFIXES = Object.freeze([
  "applicationlauncher",
  "clientlauncher",
  "applauncher",
  "sclauncher",
  "bootstrapper",
  "launcher",
  "starter",
]);
const WINDOWS_START_APPS_SCRIPT = [
  "$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()",
  "Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress",
].join("; ");
const MAC_APP_QUERY = "kMDItemContentType == 'com.apple.application-bundle'";

export class InstalledAppLauncherError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "InstalledAppLauncherError";
    this.code = code;
    if (options.details !== undefined) this.details = options.details;
  }
}

function launcherError(code, message, options) {
  return new InstalledAppLauncherError(code, message, options);
}

function compactIdentity(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\.(?:exe|app|desktop)$/iu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

export function normalizeInstalledAppName(value) {
  let normalized = compactIdentity(value);
  let changed = true;
  while (changed && normalized.length > 0) {
    changed = false;
    for (const suffix of WINDOWS_LAUNCHER_SUFFIXES) {
      if (normalized.length > suffix.length && normalized.endsWith(suffix)) {
        normalized = normalized.slice(0, -suffix.length);
        changed = true;
        break;
      }
    }
  }
  return normalized;
}

export function normalizeInstalledAppLookupKey(ref, platform = process.platform) {
  const parts = [];
  if (typeof ref?.name === "string") {
    // Bug 根因：Windows 启动器后缀只属于 Windows 安装发现语义；跨平台复用该折叠规则会把
    // macOS/Linux 上真实存在的 Foo 与 FooLauncher 错误合并，导致解析到错误的安装记录。
    const normalizedName =
      platform === "win32" ? normalizeInstalledAppName(ref.name) : compactIdentity(ref.name);
    parts.push(`name:${normalizedName}`);
  }
  if (typeof ref?.bundle_id === "string") {
    let bundleId = ref.bundle_id.normalize("NFKC").trim().toLocaleLowerCase("en-US");
    // Bug 根因：Linux 同一 desktop id 的带/不带后缀请求曾生成两个 single-flight key，
    // 并发首次观察因此可能把同一应用启动两次。
    if (platform === "linux" && bundleId.endsWith(".desktop")) {
      bundleId = bundleId.slice(0, -".desktop".length);
    }
    parts.push(`bundle:${bundleId}`);
  }
  return parts.join("\u0000");
}

function defaultRun({ file, args, cwd, signal, waitForExit = true }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? launcherError("CONTROL_STOPPED", "installed app launch was aborted"));
      return;
    }
    const child = spawn(file, args, {
      ...(cwd ? { cwd } : {}),
      detached: !waitForExit,
      shell: false,
      windowsHide: true,
      stdio: waitForExit ? ["ignore", "pipe", "pipe"] : "ignore",
      ...(waitForExit ? { signal, timeout: DEFAULT_COMMAND_TIMEOUT_MS } : {}),
    });
    if (!waitForExit) {
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve({ stdout: "", stderr: "" });
      });
      return;
    }
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    const collect = (chunks, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill();
        reject(launcherError("LAUNCH_FAILED", "installed app command output exceeded its limit"));
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) resolve(result);
      else {
        reject(
          launcherError("LAUNCH_FAILED", "installed app command failed", {
            details: { executable: file, exitCode: code },
          }),
        );
      }
    });
  });
}

function aliasesFor(record) {
  return [record.name, record.bundleId, record.appId, record.desktopId, record.executable]
    .filter((value) => typeof value === "string" && value.length > 0)
    .flatMap((value) => {
      const values = [value];
      if (value.includes("!")) values.push(value.slice(value.lastIndexOf("!") + 1));
      values.push(basename(value));
      values.push(windowsPath.basename(value));
      return values;
    });
}

function matchesBundle(record, ref) {
  if (ref.bundle_id !== undefined) {
    const expected = ref.bundle_id.normalize("NFKC").trim().toLocaleLowerCase("en-US");
    const normalize = (value) =>
      typeof value === "string" ? value.normalize("NFKC").trim().toLocaleLowerCase("en-US") : "";
    const desktopId = normalize(record.desktopId);
    const desktopExpected = expected.endsWith(".desktop")
      ? expected.slice(0, -".desktop".length)
      : expected;
    const normalizedDesktopId = desktopId.endsWith(".desktop")
      ? desktopId.slice(0, -".desktop".length)
      : desktopId;
    // Bug 根因：Windows/Linux 发现结果分别持有 appId/desktopId，旧实现却只比较
    // macOS bundleId，导致两平台显式 bundle_id 查询恒为 APP_NOT_FOUND。
    if (
      normalize(record.bundleId) !== expected &&
      normalize(record.appId) !== expected &&
      (!desktopId || normalizedDesktopId !== desktopExpected)
    ) {
      return false;
    }
  }
  return true;
}

function selectInstalledApp(records, ref, platform) {
  const bundleMatches = records.filter((record) => matchesBundle(record, ref));
  let matches = bundleMatches;
  if (ref.name !== undefined) {
    const strict = compactIdentity(ref.name);
    const exact = bundleMatches.filter((record) =>
      aliasesFor(record).some((alias) => compactIdentity(alias) === strict),
    );
    const normalizeName = platform === "win32" ? normalizeInstalledAppName : compactIdentity;
    const normalized = normalizeName(ref.name);
    matches =
      exact.length > 0
        ? exact
        : bundleMatches.filter((record) =>
            aliasesFor(record).some((alias) => normalizeName(alias) === normalized),
          );
  }
  if (matches.length === 0) {
    throw launcherError("APP_NOT_FOUND", "installed application was not found");
  }
  if (matches.length !== 1) {
    throw launcherError("AMBIGUOUS_APP", "installed application reference is ambiguous");
  }
  return matches[0];
}

function parseWindowsStartApps(stdout) {
  if (stdout.trim().length === 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw launcherError("LAUNCH_FAILED", "Windows Start Apps returned invalid data", {
      cause: error,
    });
  }
  return (Array.isArray(parsed) ? parsed : [parsed])
    .filter(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        typeof entry.Name === "string" &&
        typeof entry.AppID === "string",
    )
    .map((entry) => ({ name: entry.Name.trim(), appId: entry.AppID.trim() }));
}

async function discoverWindows(run, signal) {
  const result = await run({
    file: "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      WINDOWS_START_APPS_SCRIPT,
    ],
    signal,
  });
  return parseWindowsStartApps(result.stdout);
}

function cleanMetadataValue(value) {
  const trimmed = value.trim();
  return trimmed === "(null)" || trimmed.length === 0 ? undefined : trimmed;
}

async function discoverMacOs(run, signal) {
  const result = await run({
    file: "/usr/bin/mdfind",
    args: ["-0", MAC_APP_QUERY],
    signal,
  });
  const paths = result.stdout.split("\0").filter((value) => value.endsWith(".app"));
  return await Promise.all(
    paths.map(async (path) => {
      const [bundle, displayName] = await Promise.all([
        run({
          file: "/usr/bin/mdls",
          args: ["-name", "kMDItemCFBundleIdentifier", "-raw", path],
          signal,
        }),
        run({
          file: "/usr/bin/mdls",
          args: ["-name", "kMDItemDisplayName", "-raw", path],
          signal,
        }),
      ]);
      return {
        path,
        name: cleanMetadataValue(displayName.stdout) ?? basename(path, ".app"),
        bundleId: cleanMetadataValue(bundle.stdout),
      };
    }),
  );
}

function parseDesktopEntry(source, path, applicationsDirectory) {
  let inDesktopEntry = false;
  const values = new Map();
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      inDesktopEntry = line === "[Desktop Entry]";
      continue;
    }
    if (!inDesktopEntry || line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!values.has(key)) values.set(key, line.slice(separator + 1).trim());
  }
  if (
    values.get("Type") !== "Application" ||
    values.get("Hidden") === "true" ||
    values.get("NoDisplay") === "true" ||
    !values.get("Name") ||
    !values.get("Exec")
  ) {
    return undefined;
  }
  const executableToken = firstDesktopExecToken(values.get("Exec"));
  return {
    path,
    name: values.get("Name"),
    desktopId: desktopIdForPath(path, applicationsDirectory),
    executable: executableToken ? basename(executableToken) : undefined,
  };
}

function desktopIdForPath(path, applicationsDirectory) {
  return path.slice(applicationsDirectory.length + 1).replace(/[\\/]/gu, "-");
}

function firstDesktopExecToken(command) {
  let token = "";
  let quote;
  let escaped = false;
  for (const character of command.trim()) {
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/u.test(character)) {
      break;
    } else {
      token += character;
    }
  }
  return token;
}

async function desktopEntryPaths(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EACCES") return [];
    throw error;
  }
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return desktopEntryPaths(path);
      return entry.isFile() && entry.name.endsWith(".desktop") ? [path] : [];
    }),
  );
  return nested.flat();
}

async function discoverLinux(env) {
  const dataHome = env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share");
  const dataDirs =
    env.XDG_DATA_DIRS === undefined
      ? ["/usr/local/share", "/usr/share"]
      : env.XDG_DATA_DIRS.split(":").filter(Boolean);
  const applicationDirectories = [dataHome, ...dataDirs].map((directory) =>
    join(directory, "applications"),
  );
  const pathGroups = await Promise.all(applicationDirectories.map(desktopEntryPaths));
  const selectedPaths = new Map();
  for (let index = 0; index < pathGroups.length; index += 1) {
    for (const path of pathGroups[index]) {
      const desktopId = desktopIdForPath(path, applicationDirectories[index]);
      const key = desktopId.normalize("NFKC").toLocaleLowerCase("en-US");
      // Bug 根因：XDG 用户目录优先于系统目录；先按路径身份选中覆盖项，才能让用户级
      // Hidden=true 墓碑同时压住系统项，而不是过滤墓碑后重新暴露系统应用。
      if (!selectedPaths.has(key)) {
        selectedPaths.set(key, { path, applicationsDirectory: applicationDirectories[index] });
      }
    }
  }
  const records = await Promise.all(
    [...selectedPaths.values()].map(async ({ path, applicationsDirectory }) => {
      try {
        return parseDesktopEntry(await readFile(path, "utf8"), path, applicationsDirectory);
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "EACCES") return undefined;
        throw error;
      }
    }),
  );
  return records.filter(Boolean);
}

export function createInstalledAppLauncher(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const run = options.run ?? defaultRun;
  const controller = new AbortController();
  let disposed = false;

  function ensureActive() {
    if (disposed) throw launcherError("CONTROL_STOPPED", "installed app launcher is disposed");
  }

  async function discover() {
    let records;
    try {
      if (platform === "win32") records = await discoverWindows(run, controller.signal);
      else if (platform === "darwin") records = await discoverMacOs(run, controller.signal);
      else if (platform === "linux") records = await discoverLinux(env);
      else throw launcherError("LAUNCH_FAILED", "installed app launch is unsupported");
    } catch (error) {
      if (error instanceof InstalledAppLauncherError) throw error;
      throw launcherError("LAUNCH_FAILED", "installed applications could not be enumerated", {
        cause: error,
      });
    }
    ensureActive();
    return records;
  }

  async function resolve(ref) {
    ensureActive();
    const records = await discover();
    return { ...selectInstalledApp(records, ref, platform) };
  }

  async function launch(ref) {
    ensureActive();
    const selected = await resolve(ref);
    try {
      if (platform === "win32") {
        const executable =
          windowsPath.isAbsolute(selected.appId) && selected.appId.toLowerCase().endsWith(".exe");
        await run(
          executable
            ? {
                file: selected.appId,
                args: [],
                // Bug 根因：部分 Start Apps 启动器从 cwd 加载相对资源；继承 ZCode 的 cwd 会
                // 正常 spawn 后立即静默退出，因此绝对 exe 必须按资源管理器语义从自身目录启动。
                cwd: windowsPath.dirname(selected.appId),
                signal: controller.signal,
                waitForExit: false,
              }
            : {
                file: "explorer.exe",
                args: [`shell:AppsFolder\\${selected.appId}`],
                signal: controller.signal,
                waitForExit: false,
              },
        );
      } else if (platform === "darwin") {
        await run({
          file: "/usr/bin/open",
          args: selected.bundleId ? ["-b", selected.bundleId] : ["-a", selected.path],
          signal: controller.signal,
        });
      } else {
        await run({
          file: "gio",
          args: ["launch", selected.path],
          signal: controller.signal,
        });
      }
    } catch (error) {
      if (disposed) throw launcherError("CONTROL_STOPPED", "installed app launcher is disposed");
      throw launcherError("LAUNCH_FAILED", "installed application failed to launch", {
        cause: error,
      });
    }
    ensureActive();
    return { ...selected };
  }

  return {
    resolve,
    launch,
    async dispose() {
      if (disposed) return;
      disposed = true;
      controller.abort();
    },
  };
}
