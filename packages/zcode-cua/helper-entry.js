/* eslint-disable max-lines -- Helper lifecycle, broker transport and result projection form one process boundary. */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, appendFile, chmod, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";
import {
  CuaHelperError,
  MAX_BROKER_REQUEST_BYTES,
  createHelperBootstrapRequest,
  handleRequestLine,
  parseHelperBootstrapCredentials,
  serializeResponse,
} from "./broker.js";
import {
  HELPER_ADDON_ENV,
  HELPER_BUNDLE_ID,
  HELPER_CONTROL_PROTOCOL,
  HELPER_DISPLAY_NAME,
} from "./broker-helper-constants.js";
import {
  OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY,
  OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
  readRasterEnvelopeIdentity,
} from "./frame-contract.js";
import { CUA_APP_ASSOCIATIONS_META_KEY } from "./host-display-contract.js";
import { createInstalledAppLauncher } from "./installed-app-launcher.js";
import { createMacOsPipPresenter } from "./pip-presentation-macos.js";
import { createPipSessionCoordinator } from "./pip-session-coordinator.js";
import { createPipSessionServer } from "./pip-session-server.js";
import { createXa11yProducer, Xa11yProducerError } from "./xa11y-producer.js";

const PARENT_CHECK_INTERVAL_MS = 2000;
const STANDALONE_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_CREDENTIAL_BOOTSTRAP_TIMEOUT_MS = 10_000;
const MAX_CREDENTIAL_BOOTSTRAP_TIMEOUT_MS = 30_000;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const LINUX_PREFLIGHT_ERRORS = Object.freeze({
  NO_DISPLAY: "Linux Computer Use Helper requires an X11 or Wayland display session.",
  UINPUT_DENIED: "Linux Wayland Computer Use requires writable /dev/uinput.",
  ATSPI_UNAVAILABLE: "Linux Computer Use Helper AT-SPI capability is unavailable.",
  INPUT_UNAVAILABLE: "Linux Computer Use Helper input simulation capability is unavailable.",
});

const VALUE_ARGUMENTS = new Map([
  ["--socket", "socketPath"],
  ["--broker-socket", "socketPath"],
  ["--pip-socket", "pipSocketPath"],
  ["--parent-pid", "parentPid"],
  ["--launcher-pid", "parentPid"],
  ["--exit-log", "exitLogPath"],
  ["--pip-mode", "pipMode"],
  ["--permission-request", "permissionRequest"],
  ["--permission-preflight", "permissionPreflight"],
]);
const PRODUCER_ERROR_CODES = Object.freeze({
  PERMISSION_DENIED: "permission_denied",
  INVALID_REQUEST: "invalid_request",
  APP_NOT_FOUND: "app_not_found",
  APP_NOT_READY: "app_not_ready",
  LAUNCH_FAILED: "launch_failed",
  AMBIGUOUS_APP: "ambiguous_app",
  INVALID_APP: "invalid_request",
  ELEMENT_UNAVAILABLE: "element_unavailable",
  STALE_STATE: "element_unavailable",
  NOT_SETTABLE: "not_settable",
  NOT_SELECTABLE: "not_selectable",
  ACTION_UNAVAILABLE: "action_unavailable",
  FOREGROUND_REQUIRED: "foreground_required",
  CONTROL_STOPPED: "controller_busy",
  HELPER_UNAVAILABLE: "broker_unavailable",
  TIMEOUT: "timeout",
  STRUCTURED_STATE_UNAVAILABLE: "element_unavailable",
  INTERNAL: "internal",
});

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
  }
  return false;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CuaHelperError(`${label} is required.`, { code: "invalid_request" });
  }
  return value.trim();
}

export function parseHelperArguments(argv) {
  if (!Array.isArray(argv)) {
    throw new CuaHelperError("Helper arguments are invalid.", { code: "invalid_request" });
  }
  const values = new Map();
  for (let index = 0; index < argv.length; ) {
    const flag = argv[index];
    if (typeof flag !== "string") {
      throw new CuaHelperError("Helper arguments are invalid.", { code: "invalid_request" });
    }
    const valueName = VALUE_ARGUMENTS.get(flag);
    const value = argv[index + 1];
    if (!valueName || value === undefined || values.has(valueName)) {
      throw new CuaHelperError("Helper arguments are invalid.", { code: "invalid_request" });
    }
    values.set(valueName, value);
    index += 2;
  }
  const socketPath = requiredString(values.get("socketPath"), "Helper socket path");
  const rawParentPid = values.get("parentPid");
  const parentPid = rawParentPid === undefined ? undefined : Number(rawParentPid);
  if (parentPid !== undefined && (!Number.isSafeInteger(parentPid) || parentPid <= 0)) {
    throw new CuaHelperError("Helper parent pid must be a positive safe integer.", {
      code: "invalid_request",
    });
  }
  const permissionRequest = values.get("permissionRequest");
  if (
    permissionRequest !== undefined &&
    permissionRequest !== "accessibility" &&
    permissionRequest !== "screen_recording"
  ) {
    throw new CuaHelperError("Helper permission request is invalid.", {
      code: "invalid_request",
    });
  }
  const permissionPreflight = values.get("permissionPreflight");
  if (permissionPreflight !== undefined && permissionPreflight !== "screen_recording") {
    throw new CuaHelperError("Helper permission preflight is invalid.", {
      code: "invalid_request",
    });
  }
  if (permissionRequest && permissionPreflight) {
    throw new CuaHelperError("Helper permission modes are mutually exclusive.", {
      code: "invalid_request",
    });
  }
  const exitLogPath =
    values.get("exitLogPath") === undefined
      ? undefined
      : requiredString(values.get("exitLogPath"), "Helper exit log path");
  const pipMode = values.get("pipMode");
  if (pipMode !== undefined && pipMode !== "enabled" && pipMode !== "disabled") {
    throw new CuaHelperError("Helper PiP mode is invalid.", { code: "invalid_request" });
  }
  const pipSocketPath =
    values.get("pipSocketPath") === undefined
      ? undefined
      : requiredString(values.get("pipSocketPath"), "Helper PiP socket path");
  if (pipSocketPath === socketPath) {
    throw new CuaHelperError("Helper broker and PiP sockets must be different.", {
      code: "invalid_request",
    });
  }
  if (pipMode === "enabled" && (!pipSocketPath || parentPid === undefined)) {
    throw new CuaHelperError(
      "Helper PiP socket and managed parent are required when PiP is enabled.",
      { code: "invalid_request" },
    );
  }
  if (pipSocketPath && pipMode !== "enabled") {
    throw new CuaHelperError("Helper PiP socket requires enabled PiP mode.", {
      code: "invalid_request",
    });
  }
  return {
    socketPath,
    ...(pipSocketPath ? { pipSocketPath } : {}),
    ...(parentPid === undefined ? {} : { parentPid }),
    ...(exitLogPath ? { exitLogPath } : {}),
    ...(pipMode ? { pipMode } : {}),
    ...(permissionRequest ? { permissionRequest } : {}),
    ...(permissionPreflight ? { permissionPreflight } : {}),
  };
}

function equalCapability(actual, expected) {
  if (typeof actual !== "string") return false;
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function normalizeXa11yModule(module) {
  // Node 对 CJS 的动态 import 会合成部分具名导出；xa11y 的 App 可能在 namespace 上，
  // screenshot/inputSim 却只在 default 上。必须优先完整 default，否则 Helper 启动后截图必坏。
  if (module?.default && typeof module.default === "object") return module.default;
  if (module && typeof module === "object" && module.App) return module;
  throw new CuaHelperError("xa11y native module is unavailable.", {
    code: "broker_unavailable",
  });
}

export async function loadHelperXa11y(options = {}) {
  const env = options.env ?? process.env;
  const configuredPath = env[HELPER_ADDON_ENV]?.trim();
  if (!configuredPath) {
    return normalizeXa11yModule(await import("@crowecawcaw/xa11y"));
  }
  const loader = await import(pathToFileURL(resolve(configuredPath)).href);
  const load = loader.loadXa11y ?? loader.default;
  if (typeof load !== "function") {
    throw new CuaHelperError("Configured xa11y loader has no load function.", {
      code: "broker_unavailable",
    });
  }
  return normalizeXa11yModule(await load());
}

function linuxPreflightError(message) {
  return new CuaHelperError(message, { code: "broker_unavailable" });
}

function detectLinuxDisplaySession(env) {
  const sessionType =
    typeof env?.XDG_SESSION_TYPE === "string" ? env.XDG_SESSION_TYPE.trim().toLowerCase() : "";
  const hasWaylandDisplay =
    typeof env?.WAYLAND_DISPLAY === "string" && env.WAYLAND_DISPLAY.trim().length > 0;
  const hasX11Display = typeof env?.DISPLAY === "string" && env.DISPLAY.trim().length > 0;
  // Bug 根因：systemd/SSH 环境可能继承 XDG_SESSION_TYPE，却没有显示 socket；只看 session type
  // 会把无显示 Helper 误判为可用。它只用于两种 socket 同时存在时选择当前会话。
  if (sessionType === "wayland" && hasWaylandDisplay) return "wayland";
  if (sessionType === "x11" && hasX11Display) return "x11";
  if (hasWaylandDisplay) return "wayland";
  if (hasX11Display) return "x11";
  throw linuxPreflightError(LINUX_PREFLIGHT_ERRORS.NO_DISPLAY);
}

export async function preflightLinuxHelperCapabilities(options) {
  const platform = options?.platform ?? process.platform;
  if (platform !== "linux") return;
  const xa11y = options?.xa11y;
  const session = detectLinuxDisplaySession(options?.env ?? process.env);
  if (session === "wayland") {
    try {
      // Bug 根因：只验证 inputSim 能构造会把 /dev/uinput 的权限错误推迟到首个真实输入；
      // 必须由即将执行动作的同一 Helper 进程先做 W_OK 检查，不能由 Host 代查身份。
      await (options?.accessFile ?? access)("/dev/uinput", fsConstants.W_OK);
    } catch {
      throw linuxPreflightError(LINUX_PREFLIGHT_ERRORS.UINPUT_DENIED);
    }
  }
  try {
    if (!xa11y?.App || typeof xa11y.App.list !== "function") throw new Error("missing App.list");
    const apps = await xa11y.App.list();
    if (!Array.isArray(apps)) throw new Error("invalid App.list result");
  } catch {
    throw linuxPreflightError(LINUX_PREFLIGHT_ERRORS.ATSPI_UNAVAILABLE);
  }
  try {
    if (typeof xa11y?.inputSim !== "function") throw new Error("missing inputSim");
    const simulator = await xa11y.inputSim();
    if (
      !simulator ||
      (typeof simulator !== "object" && typeof simulator !== "function") ||
      (simulator.dispose !== undefined && typeof simulator.dispose !== "function")
    ) {
      throw new Error("invalid inputSim result");
    }
    // xa11y 0.15 的 InputSim 随 JS wrapper 生命周期释放，没有公开 dispose；未来版本若提供
    // 显式钩子则必须在 ready 前调用并等待完成，当前版本则在函数返回时丢弃唯一局部引用。
    await simulator.dispose?.();
  } catch {
    // Bug 根因：延迟创建 inputSim 会让 Helper 先发布 ready，再在第一次 click/key 时才暴露
    // 原生驱动或权限故障。启动门必须验证初始化和释放都成功，且不能产生输入副作用。
    throw linuxPreflightError(LINUX_PREFLIGHT_ERRORS.INPUT_UNAVAILABLE);
  }
}

function appIdentity(app) {
  if (!isPlainObject(app)) return undefined;
  const pid = Number.isSafeInteger(app.pid) && app.pid > 0 ? app.pid : undefined;
  const bundleId = typeof app.bundle_id === "string" && app.bundle_id ? app.bundle_id : undefined;
  const name = typeof app.name === "string" && app.name ? app.name : undefined;
  const appKey = bundleId ?? (pid === undefined ? undefined : `pid:${pid}`);
  if (!appKey) return undefined;
  return { appKey, ...(name ? { displayName: name } : {}) };
}

function appAssociations(method, value) {
  if (method === "list_apps" && Array.isArray(value)) {
    const items = value.map(appIdentity).map((identity) => identity ?? null);
    return { items };
  }
  const state = isPlainObject(value?.state) ? value.state : value;
  const primary = appIdentity(state?.app);
  return primary ? { primary } : undefined;
}

function frameAppRef(state) {
  if (!isPlainObject(state) || !isPlainObject(state.app)) return undefined;
  const app = state.app;
  const appRef =
    Number.isSafeInteger(app.pid) && app.pid > 0
      ? { pid: app.pid }
      : typeof app.bundle_id === "string" && app.bundle_id.length > 0
        ? { bundle_id: app.bundle_id }
        : typeof app.name === "string" && app.name.length > 0
          ? { name: app.name }
          : undefined;
  if (!appRef) return undefined;
  const windowId = isPlainObject(state.window) ? state.window.window_id : undefined;
  return Number.isSafeInteger(windowId) && windowId >= 0
    ? { ...appRef, window_id: windowId }
    : appRef;
}

function createFrameBlocks(screenshot, state) {
  if (!isPlainObject(screenshot)) return undefined;
  const { data, width, height, frame_id: frameId } = screenshot;
  if (
    typeof data !== "string" ||
    data.length === 0 ||
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    !Number.isSafeInteger(height) ||
    height <= 0 ||
    typeof frameId !== "string" ||
    frameId.length === 0
  ) {
    return undefined;
  }
  const mimeType = screenshot.mime_type === "image/png" ? screenshot.mime_type : undefined;
  if (!mimeType) return undefined;
  const envelope = readRasterEnvelopeIdentity({ width, height, mimeType });
  if (!envelope) return undefined;
  const appRef = frameAppRef(state);
  const officialRef = {
    type: "zcode_cua_frame_ref",
    schemaVersion: 1,
    authority: "zcode.cua/open-frame/xa11y-helper",
    frameId,
    contentProtection: OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
    mimeType,
    width,
    height,
    envelopeAlgorithm: envelope.algorithm,
    ...(appRef ? { appRef } : {}),
  };
  return {
    content: [
      { type: "image", data, mimeType },
      { type: "text", text: JSON.stringify(officialRef) },
      {
        type: "text",
        text: JSON.stringify({
          image_ref: { frame_id: frameId, mime_type: mimeType, width, height },
        }),
      },
    ],
    integrity: {
      contentProtection: OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
      envelopeAlgorithm: envelope.algorithm,
    },
  };
}

function withoutScreenshot(value) {
  if (!isPlainObject(value) || !Object.hasOwn(value, "screenshot")) return value;
  const { screenshot: _screenshot, mode, ...rest } = value;
  return { ...rest, ...(mode ? { mode, snapshot_mode: mode } : {}) };
}

export function projectProducerResult(method, value) {
  const state = isPlainObject(value?.state) ? value.state : value;
  const frame = createFrameBlocks(state?.screenshot, state);
  const structuredValue = isPlainObject(value?.state)
    ? { ...value, state: withoutScreenshot(value.state) }
    : withoutScreenshot(value);
  const structuredContent =
    isPlainObject(structuredValue) && structuredValue.mode
      ? { ...structuredValue, snapshot_mode: structuredValue.mode }
      : structuredValue;
  const content = frame?.content ?? [
    { type: "text", text: JSON.stringify(value === undefined ? null : value) },
  ];
  const associations = appAssociations(method, value);
  const meta = {
    ...(frame ? { [OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY]: frame.integrity } : {}),
    ...(associations ? { [CUA_APP_ASSOCIATIONS_META_KEY]: associations } : {}),
  };
  return {
    content,
    ...(structuredContent !== undefined ? { structuredContent } : {}),
    ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
  };
}

function producerError(error) {
  if (!(error instanceof Xa11yProducerError)) return error;
  return new CuaHelperError(error.message, {
    code: PRODUCER_ERROR_CODES[error.code] ?? "internal",
    details: error.details,
    possiblySent: error.actionSent,
    retryable: error.retry === "retry",
  });
}

async function probePermission(xa11y, capability) {
  try {
    if (capability === "screen_recording") {
      const screenshot = await xa11y.screenshot();
      const width = screenshot?.width;
      const height = screenshot?.height;
      const png = screenshot?.toPng?.();
      // 根因：原生绑定在 ABI 不匹配时可能 resolve 空对象；仅以“不抛异常”判 granted
      // 会把不可用的截图权限误报为已授权，因此必须校验真实栅格和 PNG 结果。
      if (
        !Number.isSafeInteger(width) ||
        width <= 0 ||
        !Number.isSafeInteger(height) ||
        height <= 0 ||
        !Buffer.isBuffer(png) ||
        png.length === 0
      ) {
        throw new Error("screen recording probe returned an invalid screenshot");
      }
    } else {
      const apps = await xa11y.App.list();
      if (!Array.isArray(apps)) {
        throw new Error("accessibility probe returned an invalid app list");
      }
    }
    return { state: "granted" };
  } catch (error) {
    return {
      state: "denied",
      error: error instanceof Error ? error.message : "permission probe failed",
    };
  }
}

export async function readHelperPermissionStatus(xa11y) {
  const [accessibility, screenRecording] = await Promise.all([
    probePermission(xa11y, "accessibility"),
    probePermission(xa11y, "screen_recording"),
  ]);
  return {
    available: true,
    platform: process.platform,
    grant_owner: HELPER_BUNDLE_ID,
    owner: { bundle_id: HELPER_BUNDLE_ID, display_name: HELPER_DISPLAY_NAME },
    accessibility: accessibility.state,
    accessibility_probe_ok: accessibility.state === "granted",
    screen_recording: screenRecording.state,
    screen_capture_probe: {
      ok: screenRecording.state === "granted",
      ...(screenRecording.error ? { reason: screenRecording.error } : {}),
    },
  };
}

function createPermissionAdapter(xa11y) {
  return async ({ capabilities }) => {
    const requested =
      Array.isArray(capabilities) && capabilities.length > 0
        ? capabilities
        : ["accessibility", "screen_recording"];
    const status = {};
    for (const capability of requested) {
      status[capability] = (await probePermission(xa11y, capability)).state;
    }
    return { ready: Object.values(status).every((state) => state === "granted"), status };
  };
}

function createPasteAdapter(xa11y) {
  return async ({ text }) => {
    const simulator = xa11y.inputSim?.();
    if (!simulator || typeof simulator.typeText !== "function") {
      throw new CuaHelperError("xa11y input simulator is unavailable.", {
        code: "broker_unavailable",
      });
    }
    // xa11y 没有跨平台剪贴板 API；直接注入同一文本可避免覆盖用户剪贴板，同时保留
    // `paste` 的可观察结果。富文本格式降级为文本是开源 Helper 的明确兼容语义。
    await simulator.typeText(text);
    await simulator.dispose?.();
  };
}

function trustedCaptureFromResult(method, input, value, context) {
  if (
    method !== "get_app_state" ||
    !isPlainObject(input) ||
    input.include_screenshot !== true ||
    !isPlainObject(context)
  ) {
    return undefined;
  }
  const sessionId =
    typeof context.sessionId === "string" && context.sessionId.trim() === context.sessionId
      ? context.sessionId
      : undefined;
  const turnId =
    typeof context.turnId === "string" && context.turnId.trim() === context.turnId
      ? context.turnId
      : undefined;
  const state = isPlainObject(value?.state) ? value.state : value;
  const screenshot = isPlainObject(state?.screenshot) ? state.screenshot : undefined;
  if (!sessionId || !turnId || !isPlainObject(state) || !screenshot) return undefined;
  const frameId = screenshot.frame_id;
  if (
    typeof frameId !== "string" ||
    frameId.length === 0 ||
    (state.frame_id !== undefined && state.frame_id !== frameId)
  ) {
    return undefined;
  }
  const rawTitle =
    (isPlainObject(state.window) && typeof state.window.title === "string"
      ? state.window.title
      : undefined) ??
    (isPlainObject(state.app) && typeof state.app.name === "string" ? state.app.name : undefined);
  const title =
    typeof rawTitle === "string" &&
    rawTitle.length > 0 &&
    Buffer.byteLength(rawTitle, "utf8") <= 256 &&
    !hasControlCharacter(rawTitle) &&
    rawTitle.trim() === rawTitle
      ? rawTitle
      : undefined;
  return {
    sessionId,
    turnId,
    frameId,
    mimeType: screenshot.mime_type,
    data: screenshot.data,
    width: screenshot.width,
    height: screenshot.height,
    ...(title ? { title } : {}),
  };
}

export function createHelperBackend(options) {
  const { capability, generation, producer } = options;
  let disposed = false;
  let tail = Promise.resolve();
  const serialize = (work) => {
    const result = tail.then(work);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  return {
    authorize(request) {
      const authorized =
        !disposed &&
        request.generation === generation &&
        equalCapability(request.capability, capability);
      if (authorized) options.onActivity?.();
      return authorized;
    },
    ping() {
      options.onActivity?.();
      return { ok: true };
    },
    broker_info() {
      options.onActivity?.();
      return { bundleId: options.bundleId ?? null, pid: process.pid };
    },
    permission_status() {
      options.onActivity?.();
      return options.permissionStatus?.() ?? { available: !disposed, platform: process.platform };
    },
    execute(params) {
      options.onActivity?.();
      return serialize(async () => {
        if (disposed)
          throw new CuaHelperError("Computer Use Helper is stopped.", { code: "controller_busy" });
        if (!isPlainObject(params) || !isPlainObject(params.context)) {
          throw new CuaHelperError("Computer Use execute request is invalid.", {
            code: "invalid_request",
          });
        }
        try {
          const value = await producer.dispatch(params.method, params.input, params.context);
          const capture = trustedCaptureFromResult(
            params.method,
            params.input,
            value,
            params.context,
          );
          if (capture && typeof options.onTrustedCapture === "function") {
            try {
              await options.onTrustedCapture(capture);
            } catch (error) {
              // PiP 是旁路展示；presenter 故障必须回滚其状态，但不能让真实读屏结果失败。
              try {
                await options.onPipError?.(error);
              } catch {
                // 故障清理和诊断同样属于 PiP 旁路，不能反向改变 broker 的观测结果。
              }
            }
          }
          return { result: projectProducerResult(params.method, value), responseMeta: {} };
        } catch (error) {
          throw producerError(error);
        }
      });
    },
    close_session(params) {
      options.onActivity?.();
      return serialize(async () => {
        if (isPlainObject(params?.context)) await producer.closeSession(params.context);
        return { closed: true };
      });
    },
    shutdown() {
      options.onActivity?.();
      options.requestShutdown?.();
      return { shuttingDown: true };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await tail;
      await producer.dispose();
    },
  };
}

async function removeUnixSocket(socketPath, platform) {
  if (platform === "win32") return;
  await rm(socketPath, { force: true });
}

function readRequest(socket, backend) {
  let bytes = 0;
  const chunks = [];
  let complete = false;
  const fail = (response) => {
    if (complete) return;
    complete = true;
    socket.end(serializeResponse(response));
  };
  socket.on("data", (chunk) => {
    if (complete) return;
    const newline = chunk.indexOf(0x0a);
    const part = newline < 0 ? chunk : chunk.subarray(0, newline);
    bytes += part.length;
    if (bytes > MAX_BROKER_REQUEST_BYTES) {
      fail({
        ok: false,
        error: {
          code: "request_too_large",
          message: "Computer Use broker request exceeded the 1 MiB limit.",
        },
      });
      return;
    }
    chunks.push(part);
    if (newline < 0) return;
    if (newline !== chunk.length - 1) {
      fail({
        ok: false,
        error: {
          code: "invalid_request",
          message: "Computer Use broker accepts one request per connection.",
        },
      });
      return;
    }
    complete = true;
    let line;
    try {
      line = utf8Decoder.decode(Buffer.concat(chunks, bytes));
    } catch {
      socket.end(
        serializeResponse({
          ok: false,
          error: {
            code: "invalid_request",
            message: "Computer Use broker request is not valid UTF-8.",
          },
        }),
      );
      return;
    }
    void handleRequestLine(backend, line).then(
      (response) => socket.end(serializeResponse(response)),
      (error) =>
        socket.end(
          serializeResponse({
            ok: false,
            error: {
              code: "internal",
              message:
                error instanceof Error ? error.message : "Computer Use Helper request failed.",
            },
          }),
        ),
    );
  });
  socket.once("error", () => {
    complete = true;
  });
}

export async function createHelperBrokerServer(options) {
  const socketPath = requiredString(options?.socketPath, "Helper socket path");
  const platform = options?.platform ?? process.platform;
  await removeUnixSocket(socketPath, platform);
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    readRequest(socket, options.backend);
  });
  const ready = new Promise((resolveReady, rejectReady) => {
    server.once("listening", resolveReady);
    server.once("error", rejectReady);
  });
  server.listen(socketPath);
  await ready;
  if (platform !== "win32") await chmod(socketPath, 0o600);
  let closed = false;
  return {
    socketPath,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
      await removeUnixSocket(socketPath, platform);
    },
  };
}

function createExitLogger(path) {
  return async (event, details = {}) => {
    if (!path) return;
    try {
      await appendFile(
        path,
        `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...details })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    } catch {
      // 诊断日志不能改变权限裁决或 Helper 生命周期；写失败只丢失诊断，不得放宽执行门。
    }
  };
}

export async function runHelperPermissionMode(options) {
  const { args, xa11y } = options;
  const capability = args.permissionRequest ?? args.permissionPreflight;
  if (!capability) return undefined;
  const result = await probePermission(xa11y, capability);
  await options.logExit?.(args.permissionRequest ? "permission_request" : "permission_preflight", {
    capability,
    state: result.state,
    ...(result.error ? { error: result.error } : {}),
  });
  return { capability, ...result };
}

export function waitForHelperCredentialBootstrap(options = {}) {
  const channel = options.channel ?? process;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CREDENTIAL_BOOTSTRAP_TIMEOUT_MS;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_CREDENTIAL_BOOTSTRAP_TIMEOUT_MS
  ) {
    return Promise.reject(
      new CuaHelperError("Helper credential bootstrap timeout is invalid.", {
        code: "invalid_request",
      }),
    );
  }
  const request = createHelperBootstrapRequest({
    pid: options.pid ?? process.pid,
    ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
  });
  if (
    typeof channel?.on !== "function" ||
    typeof channel?.off !== "function" ||
    typeof channel?.once !== "function" ||
    typeof channel?.send !== "function" ||
    channel.connected === false
  ) {
    return Promise.reject(
      new CuaHelperError("Helper credential bootstrap IPC is unavailable.", {
        code: "broker_unavailable",
      }),
    );
  }

  return new Promise((resolveBootstrap, rejectBootstrap) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      channel.off("message", onMessage);
      channel.off("disconnect", onDisconnect);
    };
    const fail = (message, code = "broker_unavailable") => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectBootstrap(new CuaHelperError(message, { code }));
    };
    const onDisconnect = () => {
      fail("Helper credential bootstrap IPC disconnected.");
    };
    const onMessage = (message) => {
      if (settled) return;
      const credentials = parseHelperBootstrapCredentials(message);
      if (!credentials || credentials.pid !== request.pid || credentials.nonce !== request.nonce) {
        fail("Helper credential bootstrap response is invalid.", "invalid_request");
        return;
      }
      settled = true;
      cleanup();
      resolveBootstrap({
        capability: credentials.capability,
        generation: credentials.generation,
      });
    };
    const timer = setTimeout(() => fail("Helper credential bootstrap timed out."), timeoutMs);
    timer.unref?.();
    channel.on("message", onMessage);
    channel.once("disconnect", onDisconnect);
    try {
      // 根因：SEA 会在入口完整性检查后才注册 message listener；由 Helper 主动 challenge，
      // Host 收到后再回凭据，避免父进程 spawn 后盲发造成静默丢消息。
      channel.send(request, (error) => {
        if (error) fail(`Helper credential bootstrap request failed: ${error.message}`);
      });
    } catch (error) {
      fail(
        `Helper credential bootstrap request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });
}

function sendControl(type, details = {}) {
  if (typeof process.send !== "function") return;
  process.send({ protocol: HELPER_CONTROL_PROTOCOL, type, ...details });
}

function watchParent(parentPid, requestShutdown) {
  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      requestShutdown();
    }
  }, PARENT_CHECK_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function runHelperProcess(options = {}) {
  const args = options.args ?? parseHelperArguments(process.argv.slice(2));
  const logExit = options.logExit ?? createExitLogger(args.exitLogPath);
  const loadXa11y = options.loadXa11y ?? loadHelperXa11y;
  const permissionMode =
    args.permissionRequest !== undefined || args.permissionPreflight !== undefined;
  if (permissionMode) {
    const xa11y = options.xa11y ?? (await loadXa11y({ env: options.env }));
    return runHelperPermissionMode({ args, xa11y, logExit });
  }
  const credentials =
    args.parentPid === undefined
      ? { capability: randomBytes(32).toString("base64url"), generation: 0 }
      : await (options.waitForCredentialBootstrap ?? waitForHelperCredentialBootstrap)({
          channel: options.controlChannel,
          pid: options.pid ?? process.pid,
          timeoutMs: options.credentialBootstrapTimeoutMs,
        });
  // 正常常驻模式必须先拿到一次性 IPC tuple，之后才允许加载原生绑定或绑定 socket。
  const xa11y = options.xa11y ?? (await loadXa11y({ env: options.env }));
  const permissionResult = await runHelperPermissionMode({ args, xa11y, logExit });
  if (permissionResult) return permissionResult;
  await preflightLinuxHelperCapabilities({
    platform: options.platform,
    env: options.env,
    xa11y,
    accessFile: options.accessFile,
  });
  let shutdownPromise;
  let server;
  let pipServer;
  let pipCoordinator;
  let idleTimer;
  const idleTimeoutMs = options.standaloneIdleTimeoutMs ?? STANDALONE_IDLE_TIMEOUT_MS;
  const producer =
    options.producer ??
    createXa11yProducer({
      loadXa11y: async () => xa11y,
      platform: options.platform,
      requestAccess: createPermissionAdapter(xa11y),
      paste: createPasteAdapter(xa11y),
      launcher:
        options.launcher ??
        createInstalledAppLauncher({
          platform: options.platform,
          env: options.env,
        }),
      motionProfile: options.motionProfile ?? (options.env ?? process.env).ZCODE_CUA_MOTION_PROFILE,
    });
  let backend;
  const requestShutdown = () => {
    shutdownPromise ??= Promise.resolve().then(async () => {
      if (idleTimer) clearTimeout(idleTimer);
      await pipServer?.close().catch(() => undefined);
      await backend?.dispose();
      await server?.close();
      await logExit("stopped");
    });
    return shutdownPromise;
  };
  const touchActivity = () => {
    if (args.parentPid !== undefined || shutdownPromise) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(requestShutdown, idleTimeoutMs);
    idleTimer.unref?.();
  };
  backend = createHelperBackend({
    // 设置页允许只读匿名探测。没有 Host credential tuple 时生成进程内随机秘密，确保所有
    // mutation 仍不可达；不能用空串，否则外部客户端可把“standalone”误当授权模式。
    capability: credentials.capability,
    generation: credentials.generation,
    producer,
    bundleId:
      options.platform === "darwin" || process.platform === "darwin" ? HELPER_BUNDLE_ID : null,
    permissionStatus: () => readHelperPermissionStatus(xa11y),
    onActivity: touchActivity,
    onTrustedCapture: async (capture) => {
      if (!pipCoordinator) return;
      const result = await pipCoordinator.bindCapture(capture);
      if (!result.accepted) {
        await logExit("pip_capture_rejected", { reason: result.reason });
      }
    },
    onPipError: async (error) => {
      const failedCoordinator = pipCoordinator;
      pipCoordinator = undefined;
      await failedCoordinator?.dispose().catch(() => undefined);
      await logExit("pip_unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
    },
    // 不能用 microtask 立刻关 server：它会先于 handleRequestLine 的响应续体执行，导致已认证
    // shutdown 在客户端表现为“可能已发送但连接断开”。推迟到下一事件循环，先完整回包再回收。
    requestShutdown: () => setImmediate(requestShutdown),
  });
  if (args.pipMode === "enabled") {
    try {
      const presenterFactory = options.createPipPresenter ?? createMacOsPipPresenter;
      const presenter = await presenterFactory({ env: options.env });
      pipCoordinator = createPipSessionCoordinator({ presenter });
    } catch (error) {
      await logExit("pip_unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      const pipServerFactory = options.createPipServer ?? createPipSessionServer;
      pipServer = await pipServerFactory({
        socketPath: args.pipSocketPath,
        capability: credentials.capability,
        generation: credentials.generation,
        coordinator: pipCoordinator ?? null,
        available: pipCoordinator !== undefined,
        platform: options.platform,
        onActivity: touchActivity,
      });
    } catch (error) {
      await pipCoordinator?.dispose().catch(() => undefined);
      pipCoordinator = undefined;
      await logExit("pip_server_unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  try {
    server = await createHelperBrokerServer({
      socketPath: args.socketPath,
      backend,
      platform: options.platform,
    });
  } catch (error) {
    // broker bind 失败发生在 PiP 已启动之后；若直接抛出会留下 presenter 与独立 socket。
    await pipServer?.close().catch(() => undefined);
    await backend.dispose().catch(() => undefined);
    throw error;
  }
  sendControl("transport_ready", { socketPath: args.socketPath, pid: process.pid });
  sendControl("ready", { socketPath: args.socketPath, pid: process.pid });
  await logExit("ready", { socketPath: args.socketPath, pid: process.pid });
  const stopWatching =
    args.parentPid === undefined ? () => {} : watchParent(args.parentPid, requestShutdown);
  touchActivity();
  const onMessage = (message) => {
    if (message?.protocol === HELPER_CONTROL_PROTOCOL && message.type === "shutdown") {
      void requestShutdown();
    }
  };
  process.on("message", onMessage);
  const onSignal = () => void requestShutdown();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  await new Promise((resolveStopped) => {
    const wait = () => {
      if (shutdownPromise) shutdownPromise.finally(resolveStopped);
      else setTimeout(wait, 10).unref?.();
    };
    wait();
  });
  stopWatching();
  process.off("message", onMessage);
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  return { stopped: true };
}

function isDirectEntrypoint() {
  const entry = process.argv[1];
  return typeof entry === "string" && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isDirectEntrypoint()) {
  runHelperProcess().catch((error) => {
    sendControl("error", {
      message: error instanceof Error ? error.message : "Computer Use Helper startup failed.",
    });
    process.exitCode = 1;
  });
}
