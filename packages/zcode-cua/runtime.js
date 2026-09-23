/* eslint-disable max-lines -- 产品 broker runtime 与仅供包内测试的本地 driver seam 共用失败契约。 */
// Computer Use runtime 的内部实现：权限门 + 动作校验 + 串行化队列 + 驱动 dispatch。
// 设计约束见 specs/computer-use-open-replacement.md：
// - transport/凭据失败返回占位文案；Helper 已认证的产品错误保留结构化 envelope。
// - 权限结论不缓存：每次有驱动副作用的 execute 在实际执行时重新过门。
// - nut-js 鼠标/键盘是进程级全局资源：驱动调用经本队列串行化（并发 execute 的唯一互斥点）。
// - signal 中止不抛 AbortError（桥层会折叠成协议错误丢形状），以失败形状结束；
//   已下发的驱动动作不可取消，副作用不回滚。
import { randomUUID } from "node:crypto";
import {
  BROKER_CAPABILITY_ENV,
  BROKER_GENERATION_ENV,
  BROKER_SOCKET_ENV,
  BrokerError,
  callBrokerMethod,
} from "./broker.js";
import {
  OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY,
  OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
  readRasterEnvelopeIdentity,
} from "./frame-contract.js";

export const UNAVAILABLE_TEXT = "Computer Use is not available in this build.";

// 登记的动作面。新增动作必须先更新 spec（入参契约 + 行为矩阵）。
const REGISTERED_ACTIONS = new Set([
  "screenshot",
  "move",
  "click",
  "double_click",
  "drag",
  "type",
  "key",
  "scroll",
]);

const BUTTON_NAMES = new Set(["left", "right", "middle"]);
const SCROLL_DIRECTIONS = new Set(["up", "down", "left", "right"]);

function unavailableResult() {
  return { content: [{ type: "text", text: UNAVAILABLE_TEXT }], isError: true };
}

const UNAVAILABLE_BROKER_ERROR_CODES = new Set(["aborted", "invalid_response", "unavailable"]);
const BROKER_GET_APP_STATE_TIMEOUT_MS = 30_000;

function brokerProductErrorResult(error) {
  if (!(error instanceof BrokerError) || UNAVAILABLE_BROKER_ERROR_CODES.has(error.code)) {
    return undefined;
  }
  // 根因：此前把 Helper 已认证返回的 APP_NOT_FOUND 等业务错误和“根本没有 runtime”混为一谈，
  // 导致已完整打包的产品谎报 build unavailable。结构化文本沿用 SDK 既有 error envelope 读取面。
  const envelope = {
    code: error.code,
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }),
    action_sent: error.possiblySent === true,
    dispatch_status: error.possiblySent === true ? "possibly_sent" : "not_sent",
    retryable: error.retryable === true,
  };
  try {
    return {
      content: [{ type: "text", text: JSON.stringify(envelope) }],
      isError: true,
    };
  } catch {
    return undefined;
  }
}

function readBrokerCredentials(options) {
  const env = isPlainObject(options?.env) ? options.env : process.env;
  const trimCredential = (value) => (typeof value === "string" ? value.trim() : undefined);
  const socketPath =
    trimCredential(options?.brokerSocketPath) ?? trimCredential(env?.[BROKER_SOCKET_ENV]);
  // 本项目既有 Host 把 plugin authority 与 socket 成对定向注入 node_repl；专用变量仅作为
  // 向前兼容入口，不能要求两份 secret 同时存在，否则已发布的 Host 会永久 fail closed。
  const capability =
    trimCredential(options?.brokerCapability) ??
    trimCredential(env?.[BROKER_CAPABILITY_ENV]) ??
    trimCredential(env?.ZCODE_CUA_PLUGIN_AUTHORITY);
  let configuredGeneration = options?.brokerGeneration;
  if (configuredGeneration === undefined) {
    try {
      configuredGeneration = Number(env?.[BROKER_GENERATION_ENV] ?? 0);
    } catch {
      // 根因：运行时边界接收 unknown；Symbol 等值不能交给 Number，否则会在 fail-closed 前抛出。
      return undefined;
    }
  }
  if (
    !socketPath ||
    !capability ||
    !Number.isSafeInteger(configuredGeneration) ||
    configuredGeneration < 0
  ) {
    return undefined;
  }
  return { socketPath, capability, generation: configuredGeneration };
}

function isCallToolResult(value) {
  return isPlainObject(value) && Array.isArray(value.content);
}

/**
 * 产品执行边界。Helper 在副作用发生处重新裁决权限并拥有 snapshot/index；这里不缓存
 * 权限结论，也不在 RPC 失败时回退到 nut-js，避免 node_repl 成为第二个输入所有者。
 */
export function createBrokerComputerUseRuntime(options = {}) {
  const credentials = readBrokerCredentials(options);
  const logger = isPlainObject(options?.logger) ? options.logger : undefined;
  const brokerCall =
    typeof options?.callBrokerMethod === "function" ? options.callBrokerMethod : callBrokerMethod;
  let disposed = false;

  const call = async (method, params, signal, timeoutMs) => {
    if (disposed || !credentials || signal?.aborted) return undefined;
    try {
      return await brokerCall({
        ...credentials,
        method,
        params,
        signal,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    } catch (error) {
      warn(logger, "Computer Use Helper broker request failed", {
        method,
        error: error instanceof Error ? error.message : String(error),
      });
      return brokerProductErrorResult(error);
    }
  };

  return {
    async execute(input) {
      if (
        !isPlainObject(input) ||
        typeof input.toolName !== "string" ||
        !input.toolName.trim() ||
        !isPlainObject(input.context) ||
        input.context.runtimeScope !== "main"
      ) {
        return unavailableResult();
      }
      const result = await call(
        "execute",
        {
          method: input.toolName,
          input: input.arguments ?? {},
          context: input.context,
        },
        input.signal,
        // Bug 根因：producer 的应用启动就绪预算约 10 秒，broker 旧缺省 5 秒会先断开，
        // 把仍在正常启动的应用伪报为 TIMEOUT。只放宽观察，不拖慢动作、健康检查和关闭路径。
        input.toolName === "get_app_state" ? BROKER_GET_APP_STATE_TIMEOUT_MS : undefined,
      );
      return isCallToolResult(result) ? result : unavailableResult();
    },
    async closeSession(context) {
      if (!isPlainObject(context)) return;
      await call("close_session", { context });
    },
    async dispose() {
      disposed = true;
    },
  };
}

// 官方帧三件套：栅格 + 紧随其后的引用文本 + integrity _meta。引用文本把栅格宽高
// （模型的指针坐标系契约）交给下游；core 归一化层据 _meta + 引用文本走 exact-raster
// 保留路径，截图不再被通用「超限落盘」路径吞掉。安全边界见 frame-contract.js 头注：
// 该标记不构成防伪造签名，也不参与特权判定，只表达「本 runtime 真实截取」。
function officialScreenshotResult(shot) {
  const envelope = readRasterEnvelopeIdentity({
    width: shot.width,
    height: shot.height,
    mimeType: shot.mimeType,
  });
  const hasWidth = Number.isSafeInteger(shot.width) && shot.width > 0;
  const hasHeight = Number.isSafeInteger(shot.height) && shot.height > 0;
  const ref = {
    type: "zcode_cua_frame_ref",
    schemaVersion: 1,
    authority: "zcode.cua/open-frame/local-driver",
    frameId: randomUUID(),
    contentProtection: OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
    ...(typeof shot.mimeType === "string" && shot.mimeType ? { mimeType: shot.mimeType } : {}),
    ...(hasWidth ? { width: shot.width } : {}),
    ...(hasHeight ? { height: shot.height } : {}),
    ...(envelope ? { envelopeAlgorithm: envelope.algorithm } : {}),
  };
  return {
    content: [
      { type: "image", data: shot.data, mimeType: shot.mimeType },
      { type: "text", text: JSON.stringify(ref) },
    ],
    _meta: {
      [OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY]: {
        contentProtection: OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
        ...(envelope ? { envelopeAlgorithm: envelope.algorithm } : {}),
      },
    },
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// 权限门（seam 的一部分）。缺省门谓词：brokerSocketPath trim 后非空即视为凭据存在——
// 唯一真实组装点（node-repl-host server.ts 的 captureComputerUseRuntimeFromEnvironment）
// 只在 ZCODE_CUA_PERMISSION_BROKER_SOCKET 非空时才构造 runtime，而该 env 只在 Helper broker
// 就绪并完成授权裁决后由 desktop/CLI 定向注入；因此缺省放行不是新判定者，是同一结论的
// fail-closed 复核。ensureBrokerAvailable 提供时必须 resolve，reject/抛错一律视为拒绝。
export function createBrokerPermissionGate(options = {}) {
  return {
    async authorize() {
      const socketPath = options?.brokerSocketPath;
      if (typeof socketPath !== "string" || socketPath.trim().length === 0) return false;
      if (typeof options.ensureBrokerAvailable === "function") {
        try {
          await options.ensureBrokerAvailable();
        } catch {
          return false;
        }
      }
      return true;
    },
  };
}

// ---- 动作参数严格校验：返回归一化动作对象，非法返回 undefined。 ----

function requireInteger(args, key) {
  const value = args[key];
  return Number.isSafeInteger(value) ? value : undefined;
}

function requireString(args, key) {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function optionalButton(args) {
  if (args.button === undefined) return "left";
  return BUTTON_NAMES.has(args.button) ? args.button : undefined;
}

function hasExactlyKeys(args, allowedKeys) {
  const keys = Object.keys(args);
  return keys.length <= allowedKeys.length && keys.every((key) => allowedKeys.includes(key));
}

function readArguments(value) {
  if (value === undefined) return {};
  return isPlainObject(value) ? value : undefined;
}

function validateAction(toolName, rawArguments) {
  const args = readArguments(rawArguments);
  if (!args) return undefined;
  switch (toolName) {
    case "screenshot": {
      return Object.keys(args).length === 0 ? { name: toolName } : undefined;
    }
    case "move": {
      if (!hasExactlyKeys(args, ["x", "y"])) return undefined;
      const x = requireInteger(args, "x");
      const y = requireInteger(args, "y");
      if (x === undefined || y === undefined) return undefined;
      return { name: toolName, x, y };
    }
    case "click":
    case "double_click": {
      if (!hasExactlyKeys(args, ["x", "y", "button"])) return undefined;
      const x = requireInteger(args, "x");
      const y = requireInteger(args, "y");
      const button = optionalButton(args);
      if (x === undefined || y === undefined || button === undefined) return undefined;
      return { name: toolName, x, y, button };
    }
    case "drag": {
      if (!hasExactlyKeys(args, ["fromX", "fromY", "toX", "toY", "button"])) return undefined;
      const fromX = requireInteger(args, "fromX");
      const fromY = requireInteger(args, "fromY");
      const toX = requireInteger(args, "toX");
      const toY = requireInteger(args, "toY");
      const button = optionalButton(args);
      if (
        fromX === undefined ||
        fromY === undefined ||
        toX === undefined ||
        toY === undefined ||
        button === undefined
      ) {
        return undefined;
      }
      return { name: toolName, fromX, fromY, toX, toY, button };
    }
    case "type": {
      if (!hasExactlyKeys(args, ["text"])) return undefined;
      const text = requireString(args, "text");
      if (text === undefined) return undefined;
      return { name: toolName, text };
    }
    case "key": {
      if (!hasExactlyKeys(args, ["key"])) return undefined;
      const key = requireString(args, "key");
      if (key === undefined) return undefined;
      return { name: toolName, key };
    }
    case "scroll": {
      if (!hasExactlyKeys(args, ["direction", "amount"])) return undefined;
      const direction = args.direction;
      const amount = requireInteger(args, "amount");
      if (typeof direction !== "string" || !SCROLL_DIRECTIONS.has(direction)) return undefined;
      if (amount === undefined || amount <= 0) return undefined;
      return { name: toolName, direction, amount };
    }
    default:
      return undefined;
  }
}

// 会话级资源标识：workspaceKey + sessionId 二元组（closeSession 的作用域）。
function sessionKeyOf(context) {
  if (!isPlainObject(context)) return undefined;
  const sessionId = typeof context.sessionId === "string" ? context.sessionId : "";
  const workspaceKey = typeof context.workspaceKey === "string" ? context.workspaceKey : "";
  if (!sessionId && !workspaceKey) return undefined;
  return `${workspaceKey}\u0000${sessionId}`;
}

function warn(logger, message, meta) {
  // logger 结构兼容 @zcode/contracts 的 Logger（warn(message, context)），全可选、缺省零日志。
  try {
    logger?.warn?.(message, meta);
  } catch {
    // 日志通道自身失败不得影响 execute 的失败形状返回。
  }
}

export function createComputerUseRuntimeWithDriver(driver, gate, options = {}) {
  const logger =
    isPlainObject(options) && isPlainObject(options.logger) ? options.logger : undefined;
  // key 词表谓词（spec 入参契约）：组装方注入，缺省不预检（驱动侧仍拒绝）。
  const keyNameKnown =
    isPlainObject(options) && typeof options.isKnownKeyName === "function"
      ? options.isKnownKeyName
      : undefined;
  let disposed = false;
  // 串行化队列：tail 是「上一个任务彻底落地」后的续链；queued 是等待中的活跃项，
  // 供 signal 中止与 closeSession 提前失败（跳过执行）。
  let tail = Promise.resolve();
  const queued = new Set();

  function enqueue(sessionKey, work) {
    // queued 里存 job 本体，fail/abort 直接挂在 job 上：signal 中止与 closeSession 排空共用同一定义。
    // abortedInFlight：执行中才发生的中止——驱动动作不可中止，等自然结束后折成失败形状。
    const job = {
      sessionKey,
      cancelled: false,
      abortedInFlight: false,
      settle: undefined,
      fail: undefined,
      abort: undefined,
    };
    const result = new Promise((resolve) => {
      job.settle = resolve;
    });
    job.result = result;
    job.fail = () => {
      if (job.cancelled) return;
      job.cancelled = true;
      // 提前失败：立即以占位形状 settle；轮到槽位时该 job 已取消、不会下发驱动。
      job.settle(unavailableResult());
    };
    // signal 中止的分流：排队中→立即失败且永不下发驱动；已在执行→驱动动作不可中止，
    // 等自然结束后由队列折成失败形状（副作用不回滚）。abort 必须是 job 上的方法：
    // 判定依赖 queued 里的 job 本体身份，经包装对象透出会判错。
    job.abort = () => {
      if (queued.has(job)) job.fail();
      else job.abortedInFlight = true;
    };
    const turn = tail.then(async () => {
      queued.delete(job);
      if (job.cancelled) return;
      // work 自身负责把异常折进失败形状；这里再兜一层，保证队列链永不 rejection。
      try {
        const value = await work();
        // dispose 之后 / 执行中被 signal 中止的在途调用也以失败形状返回（spec「状态与所有者」
        // 与「signal 中止的结束形状」）：驱动副作用可能已发生，但不得向调用方报成功。
        // closeSession 不适用此规则（spec 定义其不取消在途调用）。
        job.settle(job.abortedInFlight || disposed ? unavailableResult() : value);
      } catch {
        job.settle(unavailableResult());
      }
    });
    tail = turn.then(
      () => undefined,
      () => undefined,
    );
    queued.add(job);
    return job;
  }

  function failQueuedForSession(key) {
    // Set 迭代中 fail() 只 settle、不从 queued 删除，直接迭代安全。
    let drained = 0;
    for (const job of queued) {
      if (job.sessionKey === key) {
        job.fail();
        drained += 1;
      }
    }
    return drained;
  }

  async function runAction(action, signal) {
    if (signal?.aborted) return unavailableResult();
    let granted = false;
    try {
      granted = await gate.authorize();
    } catch {
      granted = false;
    }
    if (!granted) {
      warn(logger, "Computer Use action rejected by permission gate", {
        event: "zcode_cua.runtime.gate_denied",
        action: action.name,
      });
      return unavailableResult();
    }
    // 门校验期间可能已中止：不下发驱动。
    if (signal?.aborted) return unavailableResult();
    try {
      return await dispatchToDriver(action);
    } catch (error) {
      warn(logger, "Computer Use driver action failed", {
        event: "zcode_cua.runtime.driver_failed",
        action: action.name,
        reason: error instanceof Error ? error.message : String(error),
      });
      return unavailableResult();
    }
  }

  async function dispatchToDriver(action) {
    switch (action.name) {
      case "screenshot": {
        const shot = await driver.screenshot();
        return officialScreenshotResult(shot);
      }
      case "move":
        await driver.move({ x: action.x, y: action.y });
        return { content: [] };
      case "click":
        await driver.click({ x: action.x, y: action.y, button: action.button });
        return { content: [] };
      case "double_click":
        await driver.doubleClick({ x: action.x, y: action.y, button: action.button });
        return { content: [] };
      case "drag":
        await driver.drag({
          fromX: action.fromX,
          fromY: action.fromY,
          toX: action.toX,
          toY: action.toY,
          button: action.button,
        });
        return { content: [] };
      case "type":
        await driver.type({ text: action.text });
        return { content: [] };
      case "key":
        await driver.key({ key: action.key });
        return { content: [] };
      case "scroll":
        await driver.scroll({ direction: action.direction, amount: action.amount });
        return { content: [] };
      default:
        return unavailableResult();
    }
  }

  return {
    async execute(input) {
      if (disposed) return unavailableResult();
      const toolName = input?.toolName;
      // ① 廉价预检：入队前失败，不触 gate、不占驱动槽位。
      if (typeof toolName !== "string" || !REGISTERED_ACTIONS.has(toolName)) {
        return unavailableResult();
      }
      const context = input?.context;
      if (!isPlainObject(context) || context.runtimeScope === "subagent") {
        return unavailableResult();
      }
      const action = validateAction(toolName, input?.arguments);
      if (!action) return unavailableResult();
      // ① 内 key 词表预检（spec 入参契约：表外取值非法）：词表外键名不入队、不触 gate、
      // 不产生 broker 可用性调用。词表谓词由组装方注入（默认组合注入驱动的词表纯函数，
      // 保持 runtime 不耦合具体驱动）；未注入时维持既有行为，由驱动侧拒绝。
      if (
        action.name === "key" &&
        typeof keyNameKnown === "function" &&
        !keyNameKnown(action.key)
      ) {
        return unavailableResult();
      }
      const signal = input?.signal;
      // ② 入串行队列；中止/会话关闭可让排队项提前失败并跳过驱动。
      const job = enqueue(sessionKeyOf(context), () => runAction(action, signal));
      let onAbort;
      if (signal) {
        if (signal.aborted) {
          job.fail();
        } else {
          onAbort = () => job.abort();
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }
      try {
        return await job.result;
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
      }
    },

    async closeSession(context) {
      // 会话级收尾：只排空该会话仍在排队的调用（防止会话关闭后动作迟到下发）。
      // 不取消在途驱动调用（nut-js 动作不可中止）、不释放共享驱动、对未知会话与
      // dispose 之后保持幂等安全。
      if (disposed) return;
      const key = sessionKeyOf(context);
      if (!key) return;
      const drained = failQueuedForSession(key);
      if (drained > 0) {
        // spec 日志注入点列举的第四个 warn：会话关闭导致排队调用被丢弃。
        warn(logger, "Computer Use queued actions dropped for closed session", {
          event: "zcode_cua.runtime.session_queued_drained",
          drained,
        });
      }
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      // Set 迭代中 fail() 只 settle、不从 queued 删除，直接迭代安全。
      for (const job of queued) job.fail();
      queued.clear();
      try {
        await driver.dispose?.();
      } catch (error) {
        warn(logger, "Computer Use driver disposal failed", {
          event: "zcode_cua.runtime.driver_dispose_failed",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
