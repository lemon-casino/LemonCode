import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  AgentTelemetryRuntimeOwner,
  AgentExecutionTelemetryPort,
  ModelApiRuntimeSurface,
  ModelExecutionTelemetryPort,
  TelemetryIdentitySnapshot,
  TelemetryResourceContext,
} from "@lcode/contracts/telemetry";
import type { ModelStatusSink } from "@lcode/contracts/model";
import { NoopAgentExecutionTelemetry } from "./agent-trace-runtime.js";

type EnvRecord = Record<string, string | undefined>;

const TELEMETRY_STATE_LOCK_STALE_MS = 5 * 60_000;
const TELEMETRY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const BUILD_COMMIT_PATTERN = /^[0-9a-f]{7,64}$/iu;
const pendingStandaloneDeviceMidByStateFile = new Map<string, Promise<string | undefined>>();
let preparedOwner: AgentTelemetryRuntimeOwner | undefined;
let preparingOwner: Promise<AgentTelemetryRuntimeOwner | undefined> | undefined;
const noopExecution = new NoopAgentExecutionTelemetry();

export interface CreateModelTelemetryOptions {
  owner?: AgentTelemetryRuntimeOwner;
  sessionId?: string;
}

export interface ModelTelemetryBootstrap {
  agentExecution: AgentExecutionTelemetryPort;
  enabled: boolean;
  modelExecution: ModelExecutionTelemetryPort;
  statusSink?: ModelStatusSink;
  shutdown(): Promise<void>;
}

export function createModelTelemetry(
  options: CreateModelTelemetryOptions = {},
): ModelTelemetryBootstrap {
  // 显式注入优先，Endpoint 永远不能覆盖宿主提供的进程级 Owner。
  const owner = options.owner ?? preparedOwner;
  if (!owner) {
    return {
      agentExecution: noopExecution,
      enabled: false,
      modelExecution: noopExecution,
      async shutdown() {},
    };
  }
  return {
    agentExecution: owner.agentExecution,
    enabled: owner.enabled,
    modelExecution: owner.modelExecution,
    statusSink: owner.statusSink,
    async shutdown() {
      if (options.sessionId) owner.abandonSession(options.sessionId);
      // Session 只借用进程 Owner。关闭 Session 可以 flush，但不能关闭 Provider、Exporter、
      // Context Manager 或其他 Session 仍在使用的队列。
      await owner.flush({ timeoutMs: 1_500 });
    },
  };
}

export interface PrepareModelTelemetryOptions {
  buildCommitId?: string;
  cliVersion?: string;
  onWarning?: (message: string, context: Record<string, unknown>) => void;
  productVersion?: string;
  runtimeDistribution?: TelemetryResourceContext["runtimeDistribution"];
  runtimeSurface?: ModelApiRuntimeSurface;
}

export function resolveOtlpTraceEndpoint(env: EnvRecord): string | undefined {
  const traceEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (traceEndpoint) return validHttpUrl(traceEndpoint);
  const commonEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!commonEndpoint) return undefined;
  const valid = validHttpUrl(commonEndpoint);
  if (!valid) return undefined;
  const parsed = new URL(valid);
  parsed.pathname = `${parsed.pathname.replace(/\/$/u, "")}/v1/traces`;
  return parsed.toString();
}

export function resolveOtlpMetricEndpoint(env: EnvRecord): string | undefined {
  const metricEndpoint = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?.trim();
  if (metricEndpoint) return validHttpUrl(metricEndpoint);
  const commonEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (commonEndpoint) {
    const valid = validHttpUrl(commonEndpoint);
    if (!valid) return undefined;
    const parsed = new URL(valid);
    parsed.pathname = `${parsed.pathname.replace(/\/$/u, "")}/v1/metrics`;
    return parsed.toString();
  }
  // ARMS 的自定义 OTLP HTTP 接入点对 Trace/Metric 共用同一 URL；只有 traces 专用
  // 配置时沿用它，避免打包环境必须额外维护一套密钥和接入点。
  return resolveOtlpTraceEndpoint(env);
}

export function parseOtlpHeaders(value: string | undefined): Record<string, string> | undefined {
  if (!value?.trim()) return undefined;
  const headers: Record<string, string> = {};
  for (const pair of value.split(",")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const key = safeDecode(pair.slice(0, separator).trim());
    const headerValue = safeDecode(pair.slice(separator + 1).trim());
    if (key && headerValue) headers[key] = headerValue;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * 在 CLI 的异步启动边界准备身份并动态加载 OTel SDK。同步 App 工厂只借用已准备好的
 * 进程级 Owner；disabled 路径不会 import SDK/Exporter。
 */
export async function prepareModelTelemetryEnv(
  env: EnvRecord,
  options: PrepareModelTelemetryOptions = {},
): Promise<EnvRecord> {
  if (!resolveOtlpTraceEndpoint(env) || isExplicitlyDisabled(env.LCODE_MODEL_TELEMETRY_ENABLED)) {
    return env;
  }
  const existingInstallationId = normalizeTelemetryDeviceMid(env.LCODE_TELEMETRY_DEVICE_MID);
  const installationId =
    // 旧名兼容：LCODE_HOME 未设时回退旧 ZCODE_HOME（specs/brand-migration-lcode.md）。
    existingInstallationId ??
      (await resolveStandaloneDeviceMid(env.LCODE_HOME?.trim() || env.ZCODE_HOME?.trim()));
  const preparedEnv = installationId ? { ...env, LCODE_TELEMETRY_DEVICE_MID: installationId } : env;

  if (!preparingOwner && !preparedOwner) {
    preparingOwner = createPreparedOwner(preparedEnv, options);
  }
  preparedOwner = await preparingOwner;
  return preparedEnv;
}

export async function shutdownPreparedModelTelemetry(): Promise<void> {
  const owner = preparedOwner ?? (await preparingOwner);
  preparedOwner = undefined;
  preparingOwner = undefined;
  await owner?.shutdown({ timeoutMs: 1_500 });
}

export function updatePreparedTelemetryIdentity(snapshot: TelemetryIdentitySnapshot): void {
  preparedOwner?.updateIdentity(snapshot);
}

async function createPreparedOwner(
  env: EnvRecord,
  options: PrepareModelTelemetryOptions,
): Promise<AgentTelemetryRuntimeOwner | undefined> {
  const endpoint = resolveOtlpTraceEndpoint(env);
  if (!endpoint) return undefined;
  const metricEndpoint = resolveOtlpMetricEndpoint(env);
  const identity = resolveTelemetryIdentity(env);
  const resource: TelemetryResourceContext = {
    buildCommitId: normalizeBuildCommitId(options.buildCommitId ?? env.LCODE_BUILD_COMMIT_ID),
    cliVersion: normalizeVersion(options.cliVersion),
    deploymentEnvironment:
      env.LCODE_ENV ??
      env.LCODE_RUNTIME_ENV ??
      resourceAttributesFromEnv(env)["deployment.environment.name"],
    installationId: normalizeTelemetryDeviceMid(env.LCODE_TELEMETRY_DEVICE_MID),
    productVersion: normalizeVersion(options.productVersion ?? env.LCODE_APP_VERSION),
    runtimeDistribution:
      options.runtimeDistribution ??
      resolveRuntimeDistribution(env.LCODE_TELEMETRY_RUNTIME_DISTRIBUTION),
    runtimeSurface:
      options.runtimeSurface ?? resolveRuntimeSurface(env.LCODE_TELEMETRY_RUNTIME_SURFACE),
    serviceInstanceId: randomUUID(),
    serviceName: env.OTEL_SERVICE_NAME?.trim() || "lcode-cli-agent",
  };
  try {
    const { createOwnedAgentTelemetryRuntime } = await import("./otlp-exporter.js");
    return createOwnedAgentTelemetryRuntime({
      endpoint,
      headers: parseOtlpHeaders(
        env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS,
      ),
      identity,
      metricEndpoint,
      metricHeaders: parseOtlpHeaders(
        env.OTEL_EXPORTER_OTLP_METRICS_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS,
      ),
      onWarning: options.onWarning,
      resource,
    });
  } catch (error) {
    options.onWarning?.("Agent telemetry runtime initialization failed", {
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return undefined;
  }
}

function resolveTelemetryIdentity(env: EnvRecord): TelemetryIdentitySnapshot {
  const userSubjectId = normalizeTelemetryId(env.LCODE_TELEMETRY_USER_SUBJECT_ID);
  const configuredState = env.LCODE_TELEMETRY_IDENTITY_STATE?.trim();
  const identityState =
    configuredState === "authenticated" ||
    configuredState === "anonymous" ||
    configuredState === "unknown"
      ? configuredState
      : userSubjectId
        ? "authenticated"
        : normalizeTelemetryDeviceMid(env.LCODE_TELEMETRY_DEVICE_MID)
          ? "anonymous"
          : "unknown";
  return { identityState, ...(userSubjectId ? { userSubjectId } : {}) };
}

export function normalizeTelemetryDeviceMid(value: string | undefined): string | undefined {
  return normalizeTelemetryId(value);
}

function normalizeTelemetryId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && TELEMETRY_ID_PATTERN.test(normalized) ? normalized : undefined;
}

async function resolveStandaloneDeviceMid(
  lcodeHome: string | undefined,
): Promise<string | undefined> {
  const stateFile = lcodeHome
    ? join(lcodeHome, "v2", "telemetry-state.json")
    : join(homedir(), ".lcode", "v2", "telemetry-state.json");
  const pending = pendingStandaloneDeviceMidByStateFile.get(stateFile);
  if (pending) return pending;
  const resolution = resolveStandaloneDeviceMidFromFile(stateFile);
  pendingStandaloneDeviceMidByStateFile.set(stateFile, resolution);
  try {
    return await resolution;
  } finally {
    if (pendingStandaloneDeviceMidByStateFile.get(stateFile) === resolution) {
      pendingStandaloneDeviceMidByStateFile.delete(stateFile);
    }
  }
}

async function resolveStandaloneDeviceMidFromFile(stateFile: string): Promise<string | undefined> {
  try {
    const existing = await readDeviceMid(stateFile);
    if (existing) return existing;
    return await withTelemetryStateLock(stateFile, async () => {
      const state = await readTelemetryState(stateFile);
      const lockedExisting = deviceMidFromState(state);
      if (lockedExisting) return lockedExisting;
      const deviceMid = randomUUID();
      state.deviceMid = deviceMid;
      const temporary = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
      await rename(temporary, stateFile);
      return deviceMid;
    });
  } catch {
    // Bug 根因：Telemetry 身份过去在同步工厂里直接做文件 I/O，慢盘会阻塞 CLI 启动；
    // 异步准备仍必须保持旁路，读写失败只缺少匿名关联，不能影响 Agent 主链路。
    return undefined;
  }
}

async function withTelemetryStateLock(
  stateFile: string,
  run: () => Promise<string>,
): Promise<string | undefined> {
  const lockFile = join(dirname(stateFile), "telemetry-state.lock");
  await mkdir(dirname(stateFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      lockHandle = await open(lockFile, "wx");
      await lockHandle.writeFile(
        JSON.stringify({ createdAt: Date.now(), pid: process.pid }),
        "utf8",
      );
      return await run();
    } catch (error) {
      if (!isFileExistsError(error) || !(await removeStaleTelemetryStateLock(lockFile))) {
        throw error;
      }
    } finally {
      if (lockHandle !== undefined) {
        await lockHandle.close();
        try {
          await unlink(lockFile);
        } catch {
          // 另一个进程可能已回收异常残留；锁清理失败不影响模型链路。
        }
      }
    }
  }
  // 另一个活跃进程正在更新同一文件时不等待；本次仅缺少匿名 device 关联。
  return await readDeviceMid(stateFile);
}

async function removeStaleTelemetryStateLock(lockFile: string): Promise<boolean> {
  try {
    const metadata = await stat(lockFile);
    if (Date.now() - metadata.mtimeMs < TELEMETRY_STATE_LOCK_STALE_MS) {
      const owner = await readTelemetryState(lockFile);
      const pid =
        typeof owner.pid === "number" && Number.isInteger(owner.pid) ? owner.pid : undefined;
      if (!pid || isProcessAlive(pid)) return false;
    }
    await unlink(lockFile);
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    );
  }
}

function isFileExistsError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

async function readTelemetryState(stateFile: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(stateFile, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function readDeviceMid(stateFile: string): Promise<string | undefined> {
  return deviceMidFromState(await readTelemetryState(stateFile));
}

function deviceMidFromState(state: Record<string, unknown>): string | undefined {
  return typeof state.deviceMid === "string" && state.deviceMid.trim()
    ? state.deviceMid.trim()
    : undefined;
}

function resolveRuntimeSurface(value: string | undefined): ModelApiRuntimeSurface {
  switch (value?.trim()) {
    case "standalone_cli":
    case "desktop_local_host":
    case "remote_workspace_host":
      return value.trim() as ModelApiRuntimeSurface;
    default:
      return "standalone_cli";
  }
}

function resolveRuntimeDistribution(
  value: string | undefined,
): TelemetryResourceContext["runtimeDistribution"] {
  switch (value?.trim()) {
    case "source":
    case "development_bundle":
    case "packaged":
    case "unknown":
      return value.trim() as TelemetryResourceContext["runtimeDistribution"];
    default:
      return "unknown";
  }
}

function normalizeVersion(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u.test(normalized)
    ? normalized
    : undefined;
}

function normalizeBuildCommitId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && BUILD_COMMIT_PATTERN.test(normalized) ? normalized.toLowerCase() : undefined;
}

function resourceAttributesFromEnv(env: EnvRecord): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of env.OTEL_RESOURCE_ATTRIBUTES?.split(",") ?? []) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    result[safeDecode(item.slice(0, separator).trim())] = safeDecode(
      item.slice(separator + 1).trim(),
    );
  }
  return result;
}

function validHttpUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function isExplicitlyDisabled(value: string | undefined): boolean {
  return ["0", "false", "off", "disabled"].includes(value?.trim().toLowerCase() ?? "");
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
