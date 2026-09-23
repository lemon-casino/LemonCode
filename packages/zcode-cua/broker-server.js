/* oxlint-disable eslint(max-lines) -- The public compatibility barrel intentionally keeps the former broker/server API in one file. */
import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants, existsSync, readFileSync, statSync } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
  BROKER_CAPABILITY_ENV,
  BROKER_GENERATION_ENV,
  BROKER_SOCKET_ENV,
  CuaHelperError,
  callBrokerMethod,
  createHelperBootstrapCredentials,
  mintBrokerSocketPath,
  parseHelperBootstrapRequest,
  probeHelperHealth,
} from "./broker.js";
import {
  DEV_CUA_HELPER_BUNDLE_ID,
  DEV_HELPER_APP_NAME,
  HELPER_ADDON_ENV,
  HELPER_APP_NAME,
  HELPER_BUNDLE_ID,
  WINDOWS_DEV_CONTROL_PROTOCOL,
} from "./broker-helper-constants.js";

export {
  HELPER_ADDON_ENV,
  HELPER_CONTROL_PROTOCOL,
  WINDOWS_DEV_CONTROL_PROTOCOL,
} from "./broker-helper-constants.js";

const PLUGIN_AUTHORITY_ENV = "ZCODE_CUA_PLUGIN_AUTHORITY";
const OFFICIAL_CUA_PLUGIN_ID = "computer-use@zcode-plugins-official";
const LEGACY_CUA_PLUGIN_ID = "zcode-cua@zcode-plugins-official";
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const DEFAULT_STARTUP_DEADLINE_MS = 1_000;
const DEFAULT_PERMISSION_LAUNCH_TIMEOUT_MS = 10_000;
const DEFAULT_HELPER_EXIT_TIMEOUT_MS = 5_000;
const DEFAULT_HELPER_EXIT_POLL_INTERVAL_MS = 25;
const PERMISSION_PREFLIGHT_LOG_MAX_BYTES = 16 * 1024;
const MARKER_SCHEMA = 1;
const unavailableHosts = new WeakSet();
const requireFromHere = createRequire(import.meta.url);

function helperError(message, code = "helper_unavailable", details) {
  return new CuaHelperError(message, {
    code,
    ...(details === undefined ? {} : { details }),
  });
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw helperError(`${label} must be a non-empty string.`, "invalid_request");
  }
  return value.trim();
}

function optionalPositiveInteger(value, label) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw helperError(`${label} must be a positive safe integer.`, "invalid_request");
  }
  return value;
}

function optionalNonNegativeInteger(value, label) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw helperError(`${label} must be a non-negative safe integer.`, "invalid_request");
  }
  return value;
}

function truthy(value) {
  return ["1", "true", "on"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

function falsey(value) {
  return ["0", "false", "off"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

function stringifyError(error) {
  return error instanceof Error ? error.message : String(error);
}

function log(options, level, message, details) {
  const method = options?.logger?.[level];
  if (typeof method !== "function") return;
  try {
    method.call(options.logger, undefined, message, details);
  } catch {
    // Logging must never change Helper lifecycle behavior.
  }
}

function execFileResult(file, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    execFileCallback(
      file,
      args,
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, windowsHide: true, ...options },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolvePromise({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

export function buildHelperProcessArgs(spec, launcherPid) {
  if (!isRecord(spec)) {
    throw helperError("Helper launch spec must be an object.", "invalid_request");
  }
  const socketPath = nonEmptyString(spec.socketPath, "Helper socketPath");
  const pipMode =
    typeof spec.pipMode === "string" && spec.pipMode.trim() ? spec.pipMode.trim() : undefined;
  // 根因：disabled 模式仍传 PiP socket 会被 Helper 严格参数校验拒绝，且泄露一个并不存在的 transport。
  const pipSocketPath =
    pipMode === "disabled" || spec.pipSocketPath === undefined
      ? undefined
      : nonEmptyString(spec.pipSocketPath, "Helper pipSocketPath");
  if (pipSocketPath === socketPath) {
    throw helperError("Helper broker and PiP sockets must be different.", "invalid_request");
  }
  const resolvedLauncherPid = optionalPositiveInteger(
    launcherPid ?? spec.launcherPid,
    "Helper launcherPid",
  );
  const args = ["--socket", socketPath];

  if (pipSocketPath) args.push("--pip-socket", pipSocketPath);

  if (resolvedLauncherPid !== undefined) args.push("--parent-pid", String(resolvedLauncherPid));
  if (typeof spec.exitLogPath === "string" && spec.exitLogPath.trim()) {
    args.push("--exit-log", spec.exitLogPath.trim());
  }
  if (pipMode) args.push("--pip-mode", pipMode);
  if (spec.permissionRequest === "accessibility" || spec.permissionRequest === "screen_recording") {
    args.push("--permission-request", spec.permissionRequest);
  }
  if (spec.permissionPreflight === "screen_recording") {
    args.push("--permission-preflight", "screen_recording");
  }
  return args;
}

export function buildHelperOpenArgs(spec, launcherPid) {
  if (!isRecord(spec)) {
    throw helperError("Helper launch spec must be an object.", "invalid_request");
  }
  const appPath = nonEmptyString(spec.appPath, "Helper appPath");
  return [
    "-n",
    ...(spec.waitForExit === true ? ["-W"] : []),
    appPath,
    "--args",
    ...buildHelperProcessArgs(spec, launcherPid),
  ];
}

export function isCuaLocalDevelopmentRuntime(env = process.env, compiledLocalDevelopmentRuntime) {
  const compiledGate =
    typeof compiledLocalDevelopmentRuntime === "boolean"
      ? compiledLocalDevelopmentRuntime
      : env.NODE_ENV !== "production";
  return compiledGate && env.ZCODE_RUNTIME_ENV !== "production";
}

async function defaultReadPlistValue(infoPlistPath, key) {
  const { stdout } = await execFileResult("/usr/bin/plutil", [
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    infoPlistPath,
  ]);
  return stdout.trim();
}

async function optionalPlistValue(readPlistValue, infoPlistPath, key) {
  try {
    const value = await readPlistValue(infoPlistPath, key);
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

function assertBundleExecutableName(value) {
  const executable = nonEmptyString(value, "CFBundleExecutable");
  if (basename(executable) !== executable || executable === "." || executable === "..") {
    throw helperError("Helper CFBundleExecutable is unsafe.", "invalid_helper_bundle");
  }
  return executable;
}

function isPathInside(parentPath, childPath) {
  const result = relative(resolve(parentPath), resolve(childPath));
  return result === "" || (!result.startsWith(`..${sep}`) && result !== "..");
}

export async function resolveHelperPermissionSubjectIdentity(appPath, options = {}) {
  const platform = options.platform ?? process.platform;
  const dependencies = options.dependencies ?? options;
  if (platform !== "darwin" && typeof dependencies.readPlistValue !== "function") {
    throw helperError(
      "Computer Use Helper permission identity is only available on macOS.",
      "unsupported_platform",
    );
  }
  const resolveRealPath = dependencies.realpath ?? realpath;
  const readPathStat = dependencies.stat ?? stat;
  const readPlistValue = dependencies.readPlistValue ?? defaultReadPlistValue;
  const canonicalAppPath = await resolveRealPath(nonEmptyString(appPath, "Helper app path"));
  const appStat = await readPathStat(canonicalAppPath);
  if (!appStat.isDirectory?.() || !canonicalAppPath.toLowerCase().endsWith(".app")) {
    throw helperError(
      "Computer Use Helper path is not an application bundle.",
      "invalid_helper_bundle",
    );
  }
  const infoPlistPath = await resolveRealPath(join(canonicalAppPath, "Contents", "Info.plist"));
  if (!isPathInside(canonicalAppPath, infoPlistPath)) {
    throw helperError(
      "Computer Use Helper Info.plist escapes its bundle.",
      "invalid_helper_bundle",
    );
  }
  const infoPlistStat = await readPathStat(infoPlistPath);
  if (!infoPlistStat.isFile?.()) {
    throw helperError(
      "Computer Use Helper Info.plist is not a regular file.",
      "invalid_helper_bundle",
    );
  }
  const executableName = assertBundleExecutableName(
    await readPlistValue(infoPlistPath, "CFBundleExecutable"),
  );
  const executablePath = await resolveRealPath(
    join(canonicalAppPath, "Contents", "MacOS", executableName),
  );
  if (!isPathInside(canonicalAppPath, executablePath)) {
    throw helperError(
      "Computer Use Helper executable escapes its bundle.",
      "invalid_helper_bundle",
    );
  }
  const executableStat = await readPathStat(executablePath);
  if (!executableStat.isFile?.()) {
    throw helperError(
      "Computer Use Helper executable is not a regular file.",
      "invalid_helper_bundle",
    );
  }
  const bundleId = nonEmptyString(
    await readPlistValue(infoPlistPath, "CFBundleIdentifier"),
    "CFBundleIdentifier",
  );
  const displayName =
    (await optionalPlistValue(readPlistValue, infoPlistPath, "CFBundleDisplayName")) ??
    (await optionalPlistValue(readPlistValue, infoPlistPath, "CFBundleName")) ??
    basename(canonicalAppPath, ".app");
  const version = await optionalPlistValue(
    readPlistValue,
    infoPlistPath,
    "CFBundleShortVersionString",
  );
  const buildVersion = await optionalPlistValue(readPlistValue, infoPlistPath, "CFBundleVersion");
  return {
    appPath: canonicalAppPath,
    executablePath,
    displayName,
    bundleId,
    ...(version ? { version } : {}),
    ...(buildVersion ? { buildVersion } : {}),
  };
}

async function readCodeSignatureDetails(appPath) {
  try {
    const result = await execFileResult("/usr/bin/codesign", ["-d", "--verbose=4", appPath]);
    return `${result.stdout}\n${result.stderr}`;
  } catch (error) {
    const output = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`.trim();
    if (output) return output;
    throw error;
  }
}

export const defaultCuaHelperVerifierDependencies = Object.freeze({
  async readExecutableArchs(executablePath) {
    const { stdout } = await execFileResult("/usr/bin/lipo", ["-archs", executablePath]);
    return stdout.trim().split(/\s+/u).filter(Boolean);
  },
  async verifyCodeSignature(appPath) {
    await execFileResult("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      "--verbose=2",
      appPath,
    ]);
  },
  async verifyTeamIdentifier(appPath, expectedTeamIdentifier) {
    const details = await readCodeSignatureDetails(appPath);
    const actual = /^TeamIdentifier=(.+)$/mu.exec(details)?.[1]?.trim();
    if (!actual || actual === "not set") {
      throw helperError(
        "Computer Use Helper signature has no TeamIdentifier.",
        "signature_invalid",
      );
    }
    if (expectedTeamIdentifier && actual !== expectedTeamIdentifier) {
      throw helperError(
        "Computer Use Helper TeamIdentifier does not match ZCode.",
        "signature_invalid",
      );
    }
    return actual;
  },
  async verifyGatekeeper(appPath) {
    await execFileResult("/usr/sbin/spctl", [
      "--assess",
      "--type",
      "execute",
      "--verbose=4",
      appPath,
    ]);
  },
  resolveIdentity: resolveHelperPermissionSubjectIdentity,
  async copyBundle(source, destination) {
    await execFileResult("/usr/bin/ditto", ["--rsrc", "--extattr", source, destination]);
  },
});

function normalizeArchitecture(value) {
  switch (
    String(value ?? "")
      .trim()
      .toLowerCase()
  ) {
    case "amd64":
    case "x86_64":
    case "x64":
      return "x64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      return String(value ?? "")
        .trim()
        .toLowerCase();
  }
}

function resolveHelperInstallPlan(options, env) {
  const localDevelopment = isCuaLocalDevelopmentRuntime(
    env,
    options.compiledLocalDevelopmentRuntime,
  );
  const allowUnsignedLocal = localDevelopment && truthy(env.ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL);
  const variant = allowUnsignedLocal
    ? "dev"
    : env.ZCODE_CUA_HELPER_INSTALL_VARIANT?.trim() === "preview"
      ? "preview"
      : "stable";
  const root = resolve(
    options.installRoot ??
      options.plan?.installRoot ??
      join(env.ZCODE_HOME?.trim() || homedir(), "computer-use"),
  );
  const appName = variant === "dev" ? DEV_HELPER_APP_NAME : HELPER_APP_NAME;
  const variantRoot = variant === "stable" ? root : join(root, variant);
  const installPath = resolve(
    options.installPath ?? options.plan?.installPath ?? join(variantRoot, appName),
  );
  if (!installPath.toLowerCase().endsWith(".app") || !isPathInside(root, installPath)) {
    throw helperError(
      "Computer Use Helper install path is outside its install root.",
      "unsafe_path",
    );
  }
  return {
    root,
    installPath,
    variant,
    allowUnsignedLocal,
    sourcePath: options.bundledAppPath ?? options.plan?.bundledAppPath,
    expectedBundleIds:
      variant === "dev"
        ? new Set([DEV_CUA_HELPER_BUNDLE_ID, HELPER_BUNDLE_ID])
        : new Set([HELPER_BUNDLE_ID]),
  };
}

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function removeInstallScratch(path, installRoot) {
  if (!isPathInside(installRoot, path) || resolve(path) === resolve(installRoot)) {
    throw helperError("Refusing to remove an unsafe Helper install path.", "unsafe_path");
  }
  await rm(path, { recursive: true, force: true });
}

export function createCuaHelperInstaller(options = {}) {
  const env = options.env ?? process.env;
  const dependencies = {
    ...defaultCuaHelperVerifierDependencies,
    ...options.dependencies,
  };
  const plan = resolveHelperInstallPlan(options, env);

  const verifyBundle = async (appPath, verifyOptions = {}) => {
    const identity = await dependencies.resolveIdentity(appPath, {
      platform: options.platform ?? process.platform,
      ...options.identityOptions,
    });
    if (!plan.expectedBundleIds.has(identity.bundleId)) {
      throw helperError(
        `Computer Use Helper has unexpected bundle identifier ${identity.bundleId}.`,
        "identity_mismatch",
      );
    }
    const archs = (await dependencies.readExecutableArchs(identity.executablePath)).map(
      normalizeArchitecture,
    );
    const expectedArch = normalizeArchitecture(verifyOptions.arch ?? options.arch ?? process.arch);
    if (expectedArch && !archs.includes(expectedArch)) {
      throw helperError(
        `Computer Use Helper does not contain the ${expectedArch} architecture.`,
        "architecture_mismatch",
        { archs },
      );
    }
    let teamIdentifier;
    if (!plan.allowUnsignedLocal) {
      await dependencies.verifyCodeSignature(identity.appPath);
      teamIdentifier = await dependencies.verifyTeamIdentifier(
        identity.appPath,
        verifyOptions.expectedTeamIdentifier ??
          options.expectedTeamIdentifier ??
          env.ZCODE_CUA_HELPER_TEAM_IDENTIFIER?.trim() ??
          undefined,
      );
      await dependencies.verifyGatekeeper?.(identity.appPath);
    }
    return { identity, teamIdentifier };
  };

  const verifyInstalled = async (appPath, verifyOptions = {}) => {
    await verifyBundle(appPath, verifyOptions);
  };

  const isSameBundledVersion = (installed, bundled) =>
    installed.bundleId === bundled.bundleId &&
    installed.version === bundled.version &&
    installed.buildVersion === bundled.buildVersion;

  const ensureInstalled = async () => {
    const sourcePath = plan.sourcePath
      ? resolve(nonEmptyString(plan.sourcePath, "bundled Helper path"))
      : undefined;
    const sourceExists = sourcePath ? await pathExists(sourcePath) : false;
    const sourceVerification = sourceExists ? await verifyBundle(sourcePath) : undefined;

    if (await pathExists(plan.installPath)) {
      try {
        const installedVerification = await verifyBundle(plan.installPath, {
          expectedTeamIdentifier: sourceVerification?.teamIdentifier,
        });
        if (
          !sourceVerification ||
          isSameBundledVersion(installedVerification.identity, sourceVerification.identity)
        ) {
          return plan.installPath;
        }
        log(options, "info", "Bundled Computer Use Helper version changed; replacing it.", {
          installedVersion:
            installedVerification.identity.buildVersion ?? installedVerification.identity.version,
          bundledVersion:
            sourceVerification.identity.buildVersion ?? sourceVerification.identity.version,
        });
      } catch (error) {
        if (!sourceVerification) throw error;
        log(options, "warn", "Installed Computer Use Helper failed verification; replacing it.", {
          error: stringifyError(error),
        });
      }
    }
    if (!sourcePath || !sourceVerification) {
      throw helperError(
        "Computer Use Helper bundle is not available for installation.",
        "helper_bundle_missing",
      );
    }
    if (sourcePath === plan.installPath) return plan.installPath;

    await mkdir(dirname(plan.installPath), { recursive: true, mode: 0o700 });
    const nonce = `${process.pid}-${randomBytes(8).toString("hex")}`;
    const stagingPath = `${plan.installPath}.install-${nonce}`;
    const backupPath = `${plan.installPath}.backup-${nonce}`;
    let movedExisting = false;
    let installedNew = false;
    try {
      await dependencies.copyBundle(sourcePath, stagingPath);
      await verifyBundle(stagingPath, {
        expectedTeamIdentifier: sourceVerification.teamIdentifier,
      });
      if (await pathExists(plan.installPath)) {
        await rename(plan.installPath, backupPath);
        movedExisting = true;
      }
      await rename(stagingPath, plan.installPath);
      installedNew = true;
      await verifyBundle(plan.installPath, {
        expectedTeamIdentifier: sourceVerification.teamIdentifier,
      });
      if (movedExisting) {
        await removeInstallScratch(backupPath, plan.root).catch((error) => {
          log(options, "warn", "Computer Use Helper backup cleanup failed.", {
            error: stringifyError(error),
          });
        });
      }
      return plan.installPath;
    } catch (error) {
      await removeInstallScratch(stagingPath, plan.root).catch(() => undefined);
      if (installedNew) {
        // 最终路径可能已换成坏包；必须先移除它再恢复旧包，否则回滚会静默失效。
        await removeInstallScratch(plan.installPath, plan.root).catch(() => undefined);
      }
      if (movedExisting) {
        await rename(backupPath, plan.installPath).catch((rollbackError) => {
          log(options, "error", "Computer Use Helper rollback failed.", {
            error: stringifyError(rollbackError),
          });
        });
      }
      throw helperError(
        `Computer Use Helper installation failed: ${stringifyError(error)}`,
        "install_failed",
      );
    }
  };

  return { ensureInstalled, verifyInstalled };
}

export function cuaBrokerRefreshMarkerPath(socketPath) {
  if (typeof socketPath !== "string" || socketPath.trim().length === 0) return undefined;
  const normalized = socketPath.trim();
  if (normalized.startsWith("\\\\.\\pipe\\")) return undefined;
  return `${normalized}.refresh.json`;
}

export async function publishCuaBrokerRefreshMarker(socketPath, options = {}) {
  const markerPath = cuaBrokerRefreshMarkerPath(socketPath);
  if (!markerPath) return { path: undefined, dispose: async () => {} };
  const now = options.now ?? Date.now;
  const deadlineMs =
    Number.isFinite(options.deadlineMs) && options.deadlineMs > 0
      ? Math.floor(options.deadlineMs)
      : 30_000;
  const createdAt = now();
  const payload = `${JSON.stringify({
    schema: MARKER_SCHEMA,
    pid: process.pid,
    createdAt,
    expiresAt: createdAt + deadlineMs,
  })}\n`;
  const temporaryPath = `${markerPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await mkdir(dirname(markerPath), { recursive: true, mode: 0o700 });
  await writeFile(temporaryPath, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporaryPath, markerPath);
  return {
    path: markerPath,
    async dispose() {
      await unlink(markerPath).catch(() => undefined);
    },
  };
}

function existingPath(candidate) {
  if (typeof candidate !== "string" || !candidate.trim()) return undefined;
  const resolved = resolve(candidate.trim());
  return existsSync(resolved) ? resolved : undefined;
}

export function resolvePackagedNativeAddonPath(options = {}) {
  const env = options.env ?? process.env;
  const explicit = existingPath(options.modulePath ?? env[HELPER_ADDON_ENV]);
  if (explicit) return explicit;
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  if (typeof resourcesPath !== "string" || !resourcesPath.trim()) return undefined;
  const candidates = [
    join(resourcesPath, "cua-helper", "node_modules", "@crowecawcaw", "xa11y", "index.js"),
    options.relativePath
      ? join(resourcesPath, options.relativePath)
      : join(resourcesPath, "cua-helper", "xa11y-native-loader.js"),
  ];
  return candidates.map(existingPath).find(Boolean);
}

export function resolveInTreeAddonPath(options = {}) {
  const explicit = existingPath(options.modulePath ?? options.env?.[HELPER_ADDON_ENV]);
  if (explicit) return explicit;
  try {
    return requireFromHere.resolve("@crowecawcaw/xa11y");
  } catch {
    const root = resolve(options.rootPath ?? process.cwd());
    return [
      join(root, "packages", "zcode-cua", "xa11y-native-loader.js"),
      join(root, "node_modules", "@crowecawcaw", "xa11y", "index.js"),
    ]
      .map(existingPath)
      .find(Boolean);
  }
}

export function loadRealNativeAddon(options = {}) {
  const explicitlyRequested = options.modulePath ?? options.env?.[HELPER_ADDON_ENV];
  const modulePath = explicitlyRequested
    ? existingPath(explicitlyRequested)
    : (resolvePackagedNativeAddonPath(options) ?? resolveInTreeAddonPath(options));
  if (!modulePath) {
    throw helperError("Computer Use native accessibility module was not found.", "addon_missing");
  }
  try {
    const loaded = (options.require ?? requireFromHere)(modulePath);
    if (!loaded || (typeof loaded !== "object" && typeof loaded !== "function")) {
      throw new TypeError("native module returned an invalid value");
    }
    return loaded;
  } catch (error) {
    throw helperError(
      `Computer Use native accessibility module failed to load: ${stringifyError(error)}`,
      "addon_load_failed",
    );
  }
}

export const ROLE_TO_KIND = Object.freeze({
  application: "application",
  browser: "browser",
  button: "button",
  checkbox: "checkbox",
  cell: "cell",
  combobox: "combobox",
  dialog: "dialog",
  document: "document",
  group: "group",
  heading: "heading",
  image: "image",
  link: "link",
  list: "list",
  listbox: "listbox",
  listitem: "list_item",
  menu: "menu",
  menubar: "menu_bar",
  menuitem: "menu_item",
  outline: "tree",
  outlineitem: "tree_item",
  progressindicator: "progress",
  radiobutton: "radio",
  row: "row",
  scrollarea: "scroll_area",
  scrollbar: "scrollbar",
  slider: "slider",
  statictext: "text",
  switch: "switch",
  tab: "tab",
  tabgroup: "tab_list",
  table: "table",
  text: "text_input",
  textarea: "text_area",
  textfield: "text_input",
  toolbar: "toolbar",
  window: "window",
});

export function roleToKind(role) {
  if (typeof role !== "string" || role.trim().length === 0) return undefined;
  const normalized = role
    .trim()
    .replace(/^AX/u, "")
    .replace(/^UIA_/u, "")
    .replace(/ControlTypeId$/u, "")
    .replace(/[^a-z0-9]/giu, "")
    .toLowerCase();
  return ROLE_TO_KIND[normalized];
}

function normalizeElementKinds(result) {
  if (!isRecord(result) || !Array.isArray(result.elements)) return result;
  return {
    ...result,
    elements: result.elements.map((element) => {
      if (!isRecord(element) || element.kind !== undefined) return element;
      const kind = roleToKind(element.role);
      return kind ? { ...element, kind } : element;
    }),
  };
}

function resolveSourceMethod(source, candidates) {
  for (const name of candidates) {
    if (typeof source?.[name] === "function") return source[name].bind(source);
  }
  return undefined;
}

export function createAxReadOnlyMethods(source, registry, options = {}) {
  if (!isRecord(source)) {
    throw helperError("AX read-only source must be an object.", "invalid_request");
  }
  const methods = {
    list_apps: resolveSourceMethod(source, ["list_apps", "listApps"]),
    list_windows: resolveSourceMethod(source, ["list_windows", "listWindows"]),
    get_app_state: resolveSourceMethod(source, ["get_app_state", "getAppState"]),
    capture_app: resolveSourceMethod(source, ["capture_app", "captureApp"]),
  };
  return Object.fromEntries(
    Object.entries(methods).map(([name, method]) => [
      name,
      async (params, context) => {
        if (!method) {
          throw helperError(
            `Computer Use read-only method ${name} is unavailable.`,
            "method_unavailable",
          );
        }
        const result = normalizeElementKinds(await method(params, context));
        if (name === "get_app_state" && typeof registry?.recordSnapshot === "function") {
          await registry.recordSnapshot(result, context);
        }
        await options.onResult?.(name, result, context);
        return result;
      },
    ]),
  );
}

export class CuaHelperLifecycleManager {
  #disposeManaged;
  #current;
  #disposed = false;
  #tail = Promise.resolve();
  #disposedValues = new WeakSet();

  constructor(dispose) {
    this.#disposeManaged = dispose;
  }

  async #disposeOnce(managed) {
    if (managed === undefined || managed === null) return;
    if (
      (typeof managed === "object" || typeof managed === "function") &&
      this.#disposedValues.has(managed)
    ) {
      return;
    }
    if (typeof managed === "object" || typeof managed === "function") {
      this.#disposedValues.add(managed);
    }
    await this.#disposeManaged?.(managed);
  }

  async acquire(options) {
    const operation = this.#tail.then(async () => {
      if (this.#disposed) return undefined;
      if (typeof options?.isAdmitted === "function" && !options.isAdmitted()) {
        return undefined;
      }
      if (
        this.#current !== undefined &&
        (typeof options?.shouldRetainCurrent !== "function" ||
          options.shouldRetainCurrent(this.#current))
      ) {
        return this.#current;
      }
      if (this.#current !== undefined) {
        const previous = this.#current;
        this.#current = undefined;
        await this.#disposeOnce(previous);
      }
      const managed = await options?.create?.();
      if (this.#disposed) {
        await this.#disposeOnce(managed);
        return undefined;
      }
      this.#current = managed;
      return managed;
    });
    this.#tail = operation.catch(() => undefined);
    return operation;
  }

  peek() {
    return this.#current;
  }

  get disposed() {
    return this.#disposed;
  }

  async dispose(managed) {
    this.#disposed = true;
    const operation = this.#tail.then(async () => {
      const target = managed ?? this.#current;
      if (target === this.#current) this.#current = undefined;
      await this.#disposeOnce(target);
    });
    this.#tail = operation.catch(() => undefined);
    return operation;
  }
}

function workspaceRegistryKey(context) {
  const identity = context?.workspaceIdentity?.trim();
  if (identity) return identity;
  const path = context?.workspacePath?.trim();
  return path || undefined;
}

export class CuaProductHelperWorkspaceRegistry {
  #enabled = new Set();

  setEnabled(context, enabled) {
    const key = workspaceRegistryKey(context);
    if (!key) return;
    if (enabled) this.#enabled.add(key);
    else this.#enabled.delete(key);
  }

  isEnabled(context) {
    const key = workspaceRegistryKey(context);
    return key ? this.#enabled.has(key) : false;
  }

  delete(context) {
    const key = workspaceRegistryKey(context);
    return key ? this.#enabled.delete(key) : false;
  }

  clear() {
    this.#enabled.clear();
  }

  get size() {
    return this.#enabled.size;
  }
}

function createUnavailableCuaHelperHost(reason = "Computer Use is not available in this build.") {
  const reject = () => Promise.reject(helperError(reason));
  return {
    get running() {
      return false;
    },
    get socketPath() {
      return null;
    },
    get pluginAuthority() {
      return null;
    },
    get reservedTransport() {
      return undefined;
    },
    start: reject,
    stop: async () => {},
    restart: reject,
    restartAfterCurrentStart: reject,
    restartAfterCurrentStartPreservingTransport: reject,
    waitForTransport: reject,
    checkHealth: reject,
    queryScreenCaptureProbe: async () => ({ ok: false, reason }),
    queryScreenRecordingPreflight: async () => undefined,
    queryPermissionStatus: reject,
  };
}

function normalizePermissionState(value) {
  return ["granted", "stale", "denied", "unknown"].includes(value) ? value : "unknown";
}

function normalizePermissionReport(report) {
  if (!isRecord(report)) {
    throw helperError(
      "Computer Use Helper returned an invalid permission report.",
      "invalid_response",
    );
  }
  return {
    ...report,
    grant_owner: typeof report.grant_owner === "string" ? report.grant_owner : null,
    accessibility: normalizePermissionState(report.accessibility),
    screen_recording: normalizePermissionState(report.screen_recording),
  };
}

async function defaultLaunchViaLaunchServices({ args, timeoutMs }) {
  await execFileResult("/usr/bin/open", args, { timeout: timeoutMs });
}

function createCredentialFreeHelperEnv(env = process.env) {
  const childEnv = { ...env };
  delete childEnv[PLUGIN_AUTHORITY_ENV];
  delete childEnv[BROKER_CAPABILITY_ENV];
  delete childEnv[BROKER_GENERATION_ENV];
  return childEnv;
}

async function defaultLaunchProductHelper(options) {
  const identity = await (options.resolveIdentity ?? resolveHelperPermissionSubjectIdentity)(
    options.appPath,
    { platform: "darwin" },
  );
  const child = (options.spawnProcess ?? spawn)(identity.executablePath, options.args, {
    env: options.env,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    windowsHide: true,
  });
  child.stderr?.resume();
  const exited = new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  const bootstrap = await new Promise((resolveBootstrap, rejectBootstrap) => {
    let settled = false;
    let requestSeen = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectBootstrap(error);
    };
    const onError = (error) =>
      fail(helperError(`Computer Use Helper spawn failed: ${stringifyError(error)}`));
    const onExit = (code, signal) =>
      fail(
        helperError(
          `Computer Use Helper exited before credential bootstrap (code=${String(code)}, signal=${String(signal)}).`,
        ),
      );
    const onMessage = (message) => {
      const request = parseHelperBootstrapRequest(message);
      if (requestSeen || !request || request.pid !== child.pid) {
        fail(
          helperError(
            "Computer Use Helper returned an invalid credential bootstrap challenge.",
            "invalid_response",
          ),
        );
        return;
      }
      requestSeen = true;
      let credentials;
      try {
        credentials = createHelperBootstrapCredentials({
          pid: request.pid,
          nonce: request.nonce,
          capability: options.credential.capability,
          generation: options.credential.generation,
        });
        child.send(credentials, (error) => {
          if (error) {
            fail(
              helperError(
                `Computer Use Helper credential bootstrap failed: ${stringifyError(error)}`,
              ),
            );
            return;
          }
          if (settled) return;
          settled = true;
          cleanup();
          resolveBootstrap(request);
        });
      } catch (error) {
        fail(
          error instanceof CuaHelperError
            ? error
            : helperError(
                `Computer Use Helper credential bootstrap failed: ${stringifyError(error)}`,
              ),
        );
      }
    };
    const timer = setTimeout(
      () => fail(helperError("Computer Use Helper credential bootstrap timed out.")),
      options.timeoutMs,
    );
    timer.unref?.();
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });

  const terminate = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    await Promise.race([
      exited,
      new Promise((resolveTimeout) => {
        const timer = setTimeout(resolveTimeout, DEFAULT_HELPER_EXIT_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  };
  return {
    bundleId: identity.bundleId,
    executablePath: identity.executablePath,
    pid: bootstrap.pid,
    exited,
    releaseControl() {
      child.disconnect?.();
      child.unref?.();
    },
    terminate,
  };
}

async function waitForHelperProcessExit(pid, options = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const isAlive = options.isProcessAlive ?? processIsAlive;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HELPER_EXIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_HELPER_EXIT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, Math.min(pollIntervalMs, remaining)),
    );
  }
  return true;
}

export function createProductCuaHelperHost(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return createUnavailableCuaHelperHost(
      "Computer Use product Helper host is only available on macOS.",
    );
  }
  const env = options.env ?? process.env;
  const installer =
    options.helperInstaller ??
    createCuaHelperInstaller({
      env,
      logger: options.logger,
      bundledAppPath: options.bundledHelperAppPath,
      platform,
    });
  const launchApplication =
    options.launchApplication ??
    ((launchOptions) =>
      defaultLaunchProductHelper({
        ...launchOptions,
        resolveIdentity: options.resolveIdentity,
        spawnProcess: options.spawnProcess,
      }));
  const healthProbe = options.healthProbe ?? probeHelperHealth;
  const brokerCall = options.callBrokerMethod ?? callBrokerMethod;
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const waitForProcessExit = options.waitForProcessExit ?? waitForHelperProcessExit;
  const helperExitTimeoutMs = options.helperExitTimeoutMs ?? DEFAULT_HELPER_EXIT_TIMEOUT_MS;
  const socketPath =
    options.socketPath ??
    (typeof env[BROKER_SOCKET_ENV] === "string" && env[BROKER_SOCKET_ENV].trim()
      ? env[BROKER_SOCKET_ENV].trim()
      : mintBrokerSocketPath({ platform, dir: options.socketDirectory ?? tmpdir() }));
  const pipMode = options.pipMode ?? "enabled";
  const pipSocketPath =
    pipMode === "disabled" ? undefined : (options.pipSocketPath ?? `${socketPath}.pip`);
  if (pipSocketPath !== undefined && pipSocketPath === socketPath) {
    throw helperError("Helper broker and PiP sockets must be different.", "invalid_request");
  }
  const pluginAuthority =
    options.pluginAuthority ?? (options.randomBytes ?? randomBytes)(32).toString("hex");
  const generation = optionalNonNegativeInteger(options.generation, "Helper generation") ?? 0;
  let currentHandle;
  let startup;
  let stopping;

  const transport = () => ({
    socketPath,
    ...(pipSocketPath === undefined ? {} : { pipSocketPath }),
    pluginAuthority,
    generation,
  });
  const launch = async () => {
    const helperAppPath = await installer.ensureInstalled();
    const args = buildHelperProcessArgs(
      {
        socketPath,
        ...(pipSocketPath === undefined ? {} : { pipSocketPath }),
        exitLogPath: `${socketPath}.exit.log`,
        pipMode,
      },
      options.launcherPid ?? process.pid,
    );
    const launchResult = await launchApplication({
      appPath: helperAppPath,
      args,
      timeoutMs: healthTimeoutMs,
      env: createCredentialFreeHelperEnv(env),
      credential: { capability: pluginAuthority, generation },
    });
    if (
      !isRecord(launchResult) ||
      !Number.isSafeInteger(launchResult.pid) ||
      launchResult.pid <= 0 ||
      typeof launchResult.bundleId !== "string" ||
      launchResult.bundleId.length === 0
    ) {
      await launchResult?.terminate?.().catch?.(() => undefined);
      throw helperError(
        "Computer Use Helper launcher returned an invalid process identity.",
        "invalid_response",
      );
    }
    let health;
    try {
      const healthPromise = healthProbe(socketPath, {
        timeoutMs: healthTimeoutMs,
        capability: pluginAuthority,
        generation,
      });
      health = launchResult.exited
        ? await Promise.race([
            healthPromise,
            launchResult.exited.then(({ code, signal }) => {
              throw helperError(
                `Computer Use Helper exited before health validation (code=${String(code)}, signal=${String(signal)}).`,
              );
            }),
          ])
        : await healthPromise;
      if (health.bundleId !== launchResult.bundleId || health.pid !== launchResult.pid) {
        throw helperError(
          "Computer Use Helper health identity does not match its launched process.",
          "invalid_response",
          {
            expectedBundleId: launchResult.bundleId,
            expectedPid: launchResult.pid,
            actualBundleId: health.bundleId,
            actualPid: health.pid,
          },
        );
      }
      launchResult.releaseControl?.();
    } catch (error) {
      await launchResult.terminate?.().catch(() => undefined);
      throw error;
    }
    currentHandle = {
      socketPath,
      ...(pipSocketPath === undefined ? {} : { pipSocketPath }),
      launchSocketPath: socketPath,
      pluginAuthority,
      helperAppPath,
      bundleId: health.bundleId,
      pid: health.pid,
      generation,
    };
    clearCuaProductHelperAgentEnvUnavailable(host);
    return currentHandle;
  };

  const start = () => {
    if (currentHandle) return Promise.resolve(currentHandle);
    if (startup) return startup;
    startup = launch()
      .catch((error) => {
        markCuaProductHelperAgentEnvUnavailable(host);
        log(options, "warn", "Computer Use Helper failed to start.", {
          error: stringifyError(error),
        });
        throw error instanceof CuaHelperError
          ? error
          : helperError(`Computer Use Helper failed to start: ${stringifyError(error)}`);
      })
      .finally(() => {
        startup = undefined;
      });
    return startup;
  };

  const stop = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      await startup?.catch(() => undefined);
      const handle = currentHandle;
      if (handle) {
        await brokerCall({
          socketPath: handle.socketPath,
          capability: handle.pluginAuthority,
          generation: handle.generation ?? generation,
          method: "shutdown",
          params: {},
          timeoutMs: 1_000,
        }).catch(() => undefined);
        // 根因：shutdown ACK 只确认收到了请求；旧进程尾部仍会 unlink，直接复用会删掉新 socket。
        const exited = await waitForProcessExit(handle.pid, {
          timeoutMs: helperExitTimeoutMs,
          isProcessAlive: options.isProcessAlive,
        }).catch(() => false);
        if (exited !== true) {
          throw helperError(
            "Computer Use Helper shutdown could not be confirmed before reusing its transport.",
            "helper_shutdown_unconfirmed",
            { pid: handle.pid ?? null },
          );
        }
        if (currentHandle === handle) currentHandle = undefined;
      }
      if (!socketPath.startsWith("\\\\.\\pipe\\")) {
        await unlink(socketPath).catch(() => undefined);
        if (pipSocketPath !== undefined) await unlink(pipSocketPath).catch(() => undefined);
      }
    })().finally(() => {
      stopping = undefined;
    });
    return stopping;
  };

  const restartPreservingTransport = async (restartOptions = {}) => {
    await startup?.catch(() => undefined);
    await stop();
    await restartOptions.beforeFreshStart?.();
    const handle = await start();
    return { handle, reused: true };
  };

  const host = {
    get running() {
      return currentHandle !== undefined;
    },
    get socketPath() {
      return currentHandle?.socketPath ?? null;
    },
    get pipSocketPath() {
      return currentHandle?.pipSocketPath ?? null;
    },
    get pluginAuthority() {
      return currentHandle?.pluginAuthority ?? null;
    },
    get generation() {
      return generation;
    },
    get reservedTransport() {
      return transport();
    },
    start,
    stop,
    async restart() {
      return (await restartPreservingTransport()).handle;
    },
    async restartAfterCurrentStart() {
      await startup?.catch(() => undefined);
      return (await restartPreservingTransport()).handle;
    },
    restartAfterCurrentStartPreservingTransport: restartPreservingTransport,
    async waitForTransport(timeoutMs = DEFAULT_STARTUP_DEADLINE_MS) {
      const handle = await waitForCuaHelperStartup(start(), timeoutMs);
      return {
        socketPath: handle.socketPath,
        ...(handle.pipSocketPath === undefined ? {} : { pipSocketPath: handle.pipSocketPath }),
        pluginAuthority: handle.pluginAuthority,
        generation: handle.generation ?? generation,
      };
    },
    async checkHealth(timeoutMs = healthTimeoutMs) {
      const handle = currentHandle ?? (await start());
      return healthProbe(handle.socketPath, {
        timeoutMs,
        capability: handle.pluginAuthority,
        generation: handle.generation ?? generation,
      });
    },
    async queryPermissionStatus() {
      const handle = currentHandle ?? (await start());
      return normalizePermissionReport(
        await brokerCall({
          socketPath: handle.socketPath,
          capability: handle.pluginAuthority,
          generation: handle.generation ?? generation,
          method: "permission_status",
          params: {},
          timeoutMs: options.permissionTimeoutMs ?? 3_000,
        }),
      );
    },
    async queryScreenCaptureProbe() {
      const report = await host.queryPermissionStatus();
      const probe = report.screen_capture_probe;
      return isRecord(probe) && typeof probe.ok === "boolean"
        ? probe
        : { ok: false, reason: "Computer Use Helper did not return a screen-capture probe." };
    },
    async queryScreenRecordingPreflight() {
      if (typeof options.queryScreenRecordingPreflight !== "function") return undefined;
      const helperAppPath = currentHandle?.helperAppPath ?? (await installer.ensureInstalled());
      const result = await options.queryScreenRecordingPreflight({ helperAppPath, env });
      return ["granted", "denied", "unknown"].includes(result) ? result : undefined;
    },
  };
  return host;
}

function parseJsonFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readPluginEnabled(config) {
  if (!isRecord(config?.plugins)) return undefined;
  const enabled = config.plugins.enabledPlugins;
  if (!isRecord(enabled)) return undefined;
  if (typeof enabled[OFFICIAL_CUA_PLUGIN_ID] === "boolean") {
    return enabled[OFFICIAL_CUA_PLUGIN_ID];
  }
  return typeof enabled[LEGACY_CUA_PLUGIN_ID] === "boolean"
    ? enabled[LEGACY_CUA_PLUGIN_ID]
    : undefined;
}

function hasOfficialCuaPluginSuppression(config) {
  return (
    Array.isArray(config?.plugins?.suppressedBuiltins) &&
    config.plugins.suppressedBuiltins.some(
      (id) => id === OFFICIAL_CUA_PLUGIN_ID || id === LEGACY_CUA_PLUGIN_ID,
    )
  );
}

function isProjectConfigBoundary(directory) {
  try {
    const marker = statSync(join(directory, ".git"));
    return marker.isDirectory() || marker.isFile();
  } catch {
    return false;
  }
}

function discoverProjectConfigPaths(workingDirectory) {
  const start = resolve(workingDirectory);
  const directories = [];
  let current = start;
  while (true) {
    directories.push(current);
    if (isProjectConfigBoundary(current)) {
      directories.reverse();
      break;
    }
    const parent = dirname(current);
    if (parent === current) {
      // 与 CLI discovery 一致：找不到 worktree 边界时只信任显式工作目录。
      directories.splice(0, directories.length, start);
      break;
    }
    current = parent;
  }
  return directories.flatMap((directory) => [
    join(directory, "zcode.json"),
    join(directory, ".zcode", "config.json"),
  ]);
}

export function isOfficialCuaPluginEnabledForWorkspace(options = {}) {
  const env = options.env ?? process.env;
  if (falsey(env.ZCODE_CUA_PRODUCT_HELPER)) return false;
  if (truthy(env.ZCODE_CUA_DEV_MODE)) return true;
  const configs = [];
  if (isRecord(options.userConfig)) configs.push(options.userConfig);
  else {
    const home = env.ZCODE_HOME?.trim() || join(homedir(), ".zcode");
    const userConfig = parseJsonFile(options.userConfigPath ?? join(home, "cli", "config.json"));
    if (userConfig) configs.push(userConfig);
  }
  if (isRecord(options.workspaceConfig)) configs.push(options.workspaceConfig);
  else if (typeof options.workingDirectory === "string" && options.workingDirectory.trim()) {
    const workspaceConfigPaths = options.workspaceConfigPath
      ? [options.workspaceConfigPath]
      : discoverProjectConfigPaths(options.workingDirectory.trim());
    for (const configPath of workspaceConfigPaths) {
      if (!existsSync(configPath)) continue;
      const workspaceConfig = parseJsonFile(configPath);
      if (workspaceConfig) configs.push(workspaceConfig);
    }
  }
  if (configs.some(hasOfficialCuaPluginSuppression)) return false;
  let pluginSystemEnabled = true;
  let enabled;
  for (const config of configs) {
    if (typeof config.plugins?.enabled === "boolean") {
      pluginSystemEnabled = config.plugins.enabled;
    }
    const decision = readPluginEnabled(config);
    if (decision !== undefined) enabled = decision;
  }
  return pluginSystemEnabled && enabled === true;
}

function zcodeCuaArgLeaf(value) {
  const normalized = String(value ?? "")
    .trim()
    .replaceAll("\\", "/")
    .split(/[?#]/u, 1)[0]
    .replace(/\/$/u, "");
  return normalized
    .slice(normalized.lastIndexOf("/") + 1)
    .toLowerCase()
    .replaceAll("_", "-");
}

function matchesZCodeCuaSpec(value) {
  const leaf = zcodeCuaArgLeaf(value);
  return (
    leaf === "zcode-cua" ||
    leaf.startsWith("zcode-cua[") ||
    leaf.startsWith("zcode-cua@") ||
    leaf.startsWith("zcode-cua==") ||
    leaf.startsWith("zcode-cua.")
  );
}

function serverEnvironmentEntries(server) {
  if (Array.isArray(server?.env)) return server.env;
  if (isRecord(server?.env)) {
    return Object.entries(server.env).map(([name, value]) => ({ name, value: String(value) }));
  }
  return [];
}

export function isPotentialZCodeCuaAgentMcpServer(server) {
  if (!isRecord(server)) return false;
  const name = typeof server.name === "string" ? server.name.trim().toLowerCase() : "";
  if (
    name === "computer-use" ||
    name === "zcode-cua" ||
    name === "plugin:computer-use:computer-use"
  ) {
    return true;
  }
  if (
    serverEnvironmentEntries(server).some((entry) => {
      if (!isRecord(entry) || entry.name !== "ZCODE_PLUGIN_ID") return false;
      return entry.value === OFFICIAL_CUA_PLUGIN_ID || entry.value === LEGACY_CUA_PLUGIN_ID;
    })
  ) {
    return true;
  }
  if (typeof server.command === "string" && matchesZCodeCuaSpec(server.command)) return true;
  return Array.isArray(server.args) && server.args.some(matchesZCodeCuaSpec);
}

function withBrokerEnvironment(server, handle) {
  const filtered = serverEnvironmentEntries(server).filter(
    (entry) =>
      isRecord(entry) &&
      entry.name !== BROKER_SOCKET_ENV &&
      entry.name !== PLUGIN_AUTHORITY_ENV &&
      entry.name !== BROKER_GENERATION_ENV,
  );
  const env = [
    ...filtered,
    { name: BROKER_SOCKET_ENV, value: handle.socketPath },
    { name: PLUGIN_AUTHORITY_ENV, value: handle.pluginAuthority },
    { name: BROKER_GENERATION_ENV, value: String(handle.generation ?? 0) },
  ];
  return { ...server, env };
}

export function createCuaProductMcpServerResolver(host, options = {}) {
  let readyFlight;
  let restartFlight;
  let recoveryNeeded = false;
  const completedOnboardingSessions = new Set();

  const restartHost = async (restartOptions) => {
    if (restartFlight) return restartFlight;
    restartFlight = (async () => {
      if (options.hasActiveTurn?.()) {
        recoveryNeeded = true;
        throw helperError(
          "Computer Use Helper restart is deferred while a Computer Use turn is active.",
          "helper_busy",
        );
      }
      let handle;
      if (host.restartAfterCurrentStartPreservingTransport) {
        handle = (await host.restartAfterCurrentStartPreservingTransport(restartOptions)).handle;
      } else if (host.restartAfterCurrentStart) {
        await restartOptions?.beforeFreshStart?.();
        handle = await host.restartAfterCurrentStart();
      } else {
        await restartOptions?.beforeFreshStart?.();
        handle = await host.restart();
      }
      recoveryNeeded = false;
      clearCuaProductHelperAgentEnvUnavailable(host);
      return handle;
    })().finally(() => {
      restartFlight = undefined;
    });
    return restartFlight;
  };

  const ensureReady = async () => {
    if (readyFlight) return readyFlight;
    readyFlight = (async () => {
      if (host.running && host.socketPath && host.pluginAuthority) {
        try {
          await host.checkHealth?.(options.healthTimeoutMs ?? 1_000);
          recoveryNeeded = false;
          return {
            socketPath: host.socketPath,
            pipSocketPath: host.pipSocketPath ?? undefined,
            pluginAuthority: host.pluginAuthority,
            generation: host.generation ?? 0,
          };
        } catch {
          recoveryNeeded = true;
        }
      }
      const handle = await (recoveryNeeded ? restartHost() : host.start());
      if (
        !isRecord(handle) ||
        typeof handle.socketPath !== "string" ||
        !handle.socketPath.trim() ||
        typeof handle.pluginAuthority !== "string" ||
        !handle.pluginAuthority.trim()
      ) {
        throw helperError(
          "Computer Use Helper returned invalid transport credentials.",
          "invalid_response",
        );
      }
      return handle;
    })().finally(() => {
      readyFlight = undefined;
    });
    return readyFlight;
  };

  return {
    async resolveMcpServers(servers) {
      if (!Array.isArray(servers) || !servers.some(isPotentialZCodeCuaAgentMcpServer)) {
        return servers;
      }
      try {
        const handle = await ensureReady();
        return servers.map((server) =>
          isPotentialZCodeCuaAgentMcpServer(server)
            ? withBrokerEnvironment(server, handle)
            : server,
        );
      } catch (error) {
        markCuaProductHelperAgentEnvUnavailable(host);
        options.onDiagnostic?.("helper_unavailable", error);
        return servers.filter((server) => !isPotentialZCodeCuaAgentMcpServer(server));
      }
    },
    async restart() {
      await restartHost();
    },
    async restartAfterPermissionGrant(onboardingSessionId) {
      const sessionId =
        typeof onboardingSessionId === "string" && onboardingSessionId.trim()
          ? onboardingSessionId.trim()
          : undefined;
      if (sessionId && completedOnboardingSessions.has(sessionId)) return;
      const refreshSocketPath = host.socketPath ?? host.reservedTransport?.socketPath ?? null;
      await restartHost({
        beforeFreshStart: () => options.publishRefreshMarker?.(refreshSocketPath),
      });
      if (sessionId) {
        completedOnboardingSessions.add(sessionId);
        if (completedOnboardingSessions.size > 128) {
          completedOnboardingSessions.delete(completedOnboardingSessions.values().next().value);
        }
      }
    },
  };
}

export async function waitForCuaHelperStartup(startup, deadlineMs = DEFAULT_STARTUP_DEADLINE_MS) {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw helperError("Helper startup deadline must be positive.", "invalid_request");
  }
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new CuaHelperError(
            `Computer Use Helper did not become ready within ${Math.floor(deadlineMs)}ms.`,
            { code: "caller_timeout", retryable: true },
          ),
        ),
      deadlineMs,
    );
  });
  try {
    return await Promise.race([Promise.resolve(startup), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function isScreenCaptureProbeSuccess(probe) {
  return isRecord(probe) && probe.ok === true;
}

export function markCuaProductHelperAgentEnvUnavailable(host) {
  if ((typeof host === "object" && host !== null) || typeof host === "function") {
    unavailableHosts.add(host);
  }
}

export function hasCuaProductHelperAgentEnvUnavailable(host) {
  return (
    ((typeof host === "object" && host !== null) || typeof host === "function") &&
    unavailableHosts.has(host)
  );
}

export function clearCuaProductHelperAgentEnvUnavailable(host) {
  if ((typeof host === "object" && host !== null) || typeof host === "function") {
    unavailableHosts.delete(host);
  }
}

function parseProcessRows(stdout) {
  return String(stdout ?? "")
    .split(/\r?\n/u)
    .map((line) => /^\s*(\d+)\s+(.+)$/u.exec(line))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), command: match[2] }));
}

async function defaultListProcesses() {
  const { stdout } = await execFileResult("/bin/ps", ["-axo", "pid=,command="]);
  return parseProcessRows(stdout);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function helperParentPid(command) {
  // 根因：启动器已统一写出 --parent-pid；只识别旧参数会把当前 Helper 永久漏出孤儿回收。
  const canonical = /(?:^|\s)--parent-pid(?:=|\s+)(\d+)(?:\s|$)/u.exec(command);
  if (canonical) return Number(canonical[1]);
  const legacy = /(?:^|\s)--launcher-pid(?:=|\s+)(\d+)(?:\s|$)/u.exec(command);
  return legacy ? Number(legacy[1]) : undefined;
}

function looksLikeCuaHelperCommand(command) {
  return /\/(?:ZCode Computer Use|ZCode Computer Use Dev)\.app\/Contents\/MacOS\//u.test(command);
}

export async function reapOrphanedHelpers(options = {}) {
  if ((options.platform ?? process.platform) !== "darwin") return;
  const dependencies = options.dependencies ?? {};
  const listProcesses = dependencies.listProcesses ?? defaultListProcesses;
  const isAlive = dependencies.isProcessAlive ?? processIsAlive;
  const terminate = dependencies.terminate ?? ((pid) => process.kill(pid, "SIGTERM"));
  try {
    const rows = await listProcesses();
    for (const row of rows) {
      if (
        !Number.isSafeInteger(row?.pid) ||
        row.pid <= 1 ||
        row.pid === process.pid ||
        typeof row.command !== "string" ||
        !looksLikeCuaHelperCommand(row.command)
      ) {
        continue;
      }
      const parentPid = helperParentPid(row.command);
      if (!parentPid || isAlive(parentPid)) continue;
      await terminate(row.pid);
      log(options, "info", "Reaped orphaned Computer Use Helper.", {
        pid: row.pid,
        parentPid,
      });
    }
  } catch (error) {
    log(options, "warn", "Could not reap orphaned Computer Use Helpers.", {
      error: stringifyError(error),
    });
  }
}

async function requestPermissionViaLaunchServices(kind, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    return { ok: false, reason: "Computer Use permissions are only available on macOS." };
  }
  try {
    const helperAppPath = options.helperAppPath ?? (await options.ensureInstalled?.());
    if (!helperAppPath) {
      throw helperError("Computer Use Helper app path is required.", "helper_bundle_missing");
    }
    const socketPath =
      options.socketPath ?? mintBrokerSocketPath({ platform, dir: options.socketDirectory });
    const args = buildHelperOpenArgs(
      {
        appPath: helperAppPath,
        socketPath,
        permissionRequest: kind,
        exitLogPath: options.exitLogPath ?? `${socketPath}.permission.exit.log`,
      },
      options.launcherPid ?? process.pid,
    );
    await (options.launchApplication ?? defaultLaunchViaLaunchServices)({
      appPath: helperAppPath,
      args,
      timeoutMs: options.timeoutMs ?? DEFAULT_PERMISSION_LAUNCH_TIMEOUT_MS,
      env: createCredentialFreeHelperEnv(options.env ?? process.env),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: stringifyError(error) };
  }
}

export function requestHelperAccessibilityPermissionViaLaunchServices(options = {}) {
  return requestPermissionViaLaunchServices("accessibility", options);
}

export function requestHelperScreenRecordingPermissionViaLaunchServices(options = {}) {
  return requestPermissionViaLaunchServices("screen_recording", options);
}

async function readPermissionPreflightState(exitLogPath) {
  const file = await stat(exitLogPath);
  if (!file.isFile() || file.size <= 0 || file.size > PERMISSION_PREFLIGHT_LOG_MAX_BYTES) {
    return undefined;
  }
  const lines = (await readFile(exitLogPath, "utf8"))
    .split(/\r?\n/u)
    .filter((line) => line.length > 0);
  if (lines.length !== 1) return undefined;
  try {
    const record = JSON.parse(lines[0]);
    if (
      !isRecord(record) ||
      record.event !== "permission_preflight" ||
      record.capability !== "screen_recording" ||
      (record.state !== "granted" && record.state !== "denied")
    ) {
      return undefined;
    }
    return record.state;
  } catch {
    return undefined;
  }
}

export async function queryHelperScreenRecordingPreflightViaLaunchServices(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return undefined;
  const env = options.env ?? process.env;
  const socketDirectory = options.socketDirectory ?? tmpdir();
  const socketPath = options.socketPath ?? mintBrokerSocketPath({ platform, dir: socketDirectory });
  const exitLogPath = join(
    socketDirectory,
    `.zcode-cua-screen-preflight-${process.pid}-${randomBytes(12).toString("hex")}.jsonl`,
  );
  try {
    const helperAppPath = options.helperAppPath ?? (await options.ensureInstalled?.());
    if (!helperAppPath) return undefined;
    const args = buildHelperOpenArgs(
      {
        appPath: helperAppPath,
        socketPath,
        exitLogPath,
        permissionPreflight: "screen_recording",
        waitForExit: true,
      },
      options.launcherPid ?? process.pid,
    );
    await (options.launchApplication ?? defaultLaunchViaLaunchServices)({
      appPath: helperAppPath,
      args,
      timeoutMs: options.timeoutMs ?? DEFAULT_PERMISSION_LAUNCH_TIMEOUT_MS,
      env: createCredentialFreeHelperEnv(env),
    });
    return await readPermissionPreflightState(exitLogPath);
  } catch {
    // 新进程预检只是修正常驻进程的陈旧 TCC 报告；失败时由 services 沿用原报告，
    // 不能把启动/诊断异常伪造成 granted 或 denied。
    return undefined;
  } finally {
    await rm(exitLogPath, { force: true }).catch(() => undefined);
  }
}
