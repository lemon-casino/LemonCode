import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  runtimeEnvironmentServiceActionParamsSchema,
  type ManagedServiceReceipt,
  type RuntimeEnvironmentRecord,
  type RuntimeEnvironmentServiceActionParams,
  type RuntimeEnvironmentServiceActionResult,
} from "@lcode/shared";
import type { ResolvedProjectExecutionContext } from "../contract.js";
import type { ServiceDefinition } from "../domain/services.js";
import { identityKeyOf, scopeKeyHash } from "./ports.js";
import { createServiceOwnerControl } from "./serviceControlOwner.js";
import {
  startManagedService,
  stopManagedService,
  type ServiceStageContext,
  type ServiceStageResult,
} from "./serviceStage.js";

export interface ServiceControlOptions extends Omit<
  ServiceStageContext,
  "stamp" | "prepareLaunch"
> {
  stamp?: () => string;
  /** 可信项目定义查找，客户端只有 serviceId，不能提交 argv/cwd/env。 */
  resolveDefinition: (
    params: RuntimeEnvironmentServiceActionParams,
    record: RuntimeEnvironmentRecord,
  ) => Promise<ServiceDefinition | null>;
  /** 必须按传入的 environmentId/revision 读取冻结上下文，不能临时读“最新版”。 */
  resolveContext: (record: RuntimeEnvironmentRecord) => Promise<ResolvedProjectExecutionContext>;
}
function canonical(path: string): string {
  const result = resolve(path);
  return process.platform === "win32" ? result.toLowerCase() : result;
}
function sameScope(
  record: RuntimeEnvironmentRecord,
  input: RuntimeEnvironmentServiceActionParams,
): boolean {
  return (
    identityKeyOf(record.scope) === identityKeyOf(input) &&
    canonical(record.scope.workspacePath) === canonical(input.workspacePath)
  );
}
function contains(root: string, cwd: string): boolean {
  const child = relative(canonical(root), canonical(cwd));
  return (
    isAbsolute(cwd) &&
    (child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)))
  );
}
function wire(result: ServiceStageResult): RuntimeEnvironmentServiceActionResult {
  return { ...result, status: result.status === "stopFailed" ? "blocked" : result.status };
}
function overlayEnvironment(
  context: ResolvedProjectExecutionContext,
  definition: ServiceDefinition,
): Record<string, string> {
  const env: Record<string, string> = {};
  const set = (name: string, value?: string) => {
    // Windows 环境键不区分大小写，不能同时保留 PATH/Path 让 Node 选择旧值。
    if (process.platform === "win32") {
      for (const key of Object.keys(env))
        if (key.toUpperCase() === name.toUpperCase()) delete env[key];
    }
    if (value !== undefined) env[name] = value;
  };
  if (context.envOverlay.base !== "empty")
    for (const [name, value] of Object.entries(process.env)) set(name, value);
  for (const name of context.envOverlay.unset ?? []) {
    delete env[name];
    if (process.platform === "win32")
      for (const key of Object.keys(env))
        if (key.toUpperCase() === name.toUpperCase()) delete env[key];
  }
  for (const [name, value] of Object.entries(context.envOverlay.set ?? {})) set(name, value);
  for (const [name, value] of Object.entries(definition.env ?? {})) set(name, value);
  return env;
}

/**
 * spec §12：input → 环境 owner 短锁校验/starting → 锁外 spawn/health → 同锁代际结算。
 * stop/fence → 同 owner abort/stop → child close → 清 URLs/租约；旧 callback 不能覆盖新版。
 */
export function createServiceControl(options: ServiceControlOptions) {
  const context: ServiceStageContext = {
    ...options,
    stamp: options.stamp ?? (() => new Date().toISOString()),
    prepareLaunch: async (record, definition) => {
      const frozen = await options.resolveContext(record);
      if (
        frozen.environmentId !== record.environmentId ||
        frozen.revision !== record.currentRevision ||
        identityKeyOf(frozen.executionScope) !== identityKeyOf(record.scope) ||
        canonical(frozen.executionScope.workspacePath) !== canonical(record.scope.workspacePath) ||
        canonical(frozen.cwd) !== canonical(definition.cwd) ||
        !contains(record.scope.workspacePath, definition.cwd)
      )
        throw Object.assign(
          new Error("stale-reference: service context does not match its admitted generation"),
          { code: "stale-reference" },
        );
      const [command, ...args] = definition.argv;
      if (!command) throw new Error("configuration-conflict: service command is empty");
      const executable = frozen.toolPaths[command] ?? command;
      let argv = [executable, ...args];
      if (frozen.toolPaths[command] && [".js", ".cjs", ".mjs"].includes(extname(executable))) {
        const node = frozen.toolPaths.node;
        if (!node || !isAbsolute(node))
          throw new Error("tool-unavailable: frozen Node is required for a script tool");
        argv = [node, executable, ...args];
      }
      return {
        argv,
        cwd: frozen.cwd,
        env: overlayEnvironment(frozen, definition),
        ports: definition.ports,
      };
    },
  };
  async function admittedRecord(input: RuntimeEnvironmentServiceActionParams): Promise<{
    record?: RuntimeEnvironmentRecord;
    result?: RuntimeEnvironmentServiceActionResult;
  }> {
    return options.store.lock(input.environmentId, async () => {
      const record = await options.store.readEnvironment(input.environmentId);
      if (!record)
        return {
          result: { status: "blocked", reason: "stale-reference: environment does not exist" },
        };
      if (!sameScope(record, input))
        return {
          result: { status: "blocked", reason: "scope-mismatch: service environment differs" },
        };
      if (record.currentRevision !== input.expectedRevision)
        return {
          result: {
            status: "needsRestart",
            reason: "stale-reference: environment revision differs",
          },
        };
      return { record };
    });
  }
  async function localStart(
    input: RuntimeEnvironmentServiceActionParams,
    onlyOwnedGeneration = false,
  ): Promise<RuntimeEnvironmentServiceActionResult> {
    const params = runtimeEnvironmentServiceActionParamsSchema.parse(input);
    const admission = await admittedRecord(params);
    if (admission.result) return admission.result;
    const record = admission.record!;
    if (record.status !== "ready")
      return { status: "blocked", reason: "resource-busy: environment is fenced or not ready" };
    let definition: ServiceDefinition | null;
    try {
      definition = await options.resolveDefinition(params, record);
    } catch {
      return {
        status: "blocked",
        reason: "configuration-conflict: trusted service definition could not be resolved",
      };
    }
    if (
      !definition ||
      definition.serviceId !== params.serviceId ||
      !contains(record.scope.workspacePath, definition.cwd)
    )
      return {
        status: "blocked",
        reason: "configuration-conflict: unknown or out-of-scope service definition",
      };
    const operationId = scopeKeyHash([
      "service-start",
      identityKeyOf(params),
      params.environmentId,
      params.serviceId,
      params.requestId,
    ]);
    return wire(
      await startManagedService(context, record, definition, {
        operationId,
        expectedGeneration: params.expectedGeneration,
        onlyOwnedGeneration,
      }),
    );
  }
  async function localStop(
    input: RuntimeEnvironmentServiceActionParams,
  ): Promise<RuntimeEnvironmentServiceActionResult> {
    const params = runtimeEnvironmentServiceActionParamsSchema.parse(input);
    const admission = await admittedRecord(params);
    if (admission.result) return admission.result;
    return wire(
      await stopManagedService(context, admission.record!, params.serviceId, {
        expectedGeneration: params.expectedGeneration,
      }),
    );
  }
  const ownerControl = createServiceOwnerControl(context, { start: localStart, stop: localStop });
  async function startService(
    input: RuntimeEnvironmentServiceActionParams,
  ): Promise<RuntimeEnvironmentServiceActionResult> {
    const params = runtimeEnvironmentServiceActionParamsSchema.parse(input);
    return ownerControl.forwardResult("start", params, await localStart(params));
  }
  async function stopService(
    input: RuntimeEnvironmentServiceActionParams,
  ): Promise<RuntimeEnvironmentServiceActionResult> {
    const params = runtimeEnvironmentServiceActionParamsSchema.parse(input);
    return ownerControl.forwardResult("stop", params, await localStop(params));
  }
  async function stopAll(record: RuntimeEnvironmentRecord): Promise<{
    status: "stopped" | "blocked";
    receipts: ManagedServiceReceipt[];
    reason?: string;
  }> {
    // 调用方先持短锁 fence，再锁外调用；不在 environment lock 内等待任何进程退出。
    const ids = await options.store.lock(record.environmentId, () =>
      options.store.listServiceIds(record.environmentId),
    );
    const receipts: ManagedServiceReceipt[] = [];
    let reason: string | undefined;
    for (const serviceId of ids) {
      const result = await stopService({
        ...record.scope,
        environmentId: record.environmentId,
        expectedRevision: record.currentRevision,
        serviceId,
        requestId: `fence-stop-${record.currentRevision}`,
      });
      if (result.receipt) receipts.push(result.receipt);
      if (result.status !== "stopped" && result.status !== "notRunning")
        reason = result.reason ?? "process-unknown: service exit is not confirmed";
    }
    return { status: reason ? "blocked" : "stopped", receipts, ...(reason ? { reason } : {}) };
  }
  return {
    startService,
    stopService,
    stopAll,
    owns: ownerControl.owns,
    handleOwnerRequest: ownerControl.handleOwnerRequest,
    attachOwnerChannel: ownerControl.attachOwnerChannel,
    reconcileReceipt: ownerControl.reconcileReceipt,
  };
}
