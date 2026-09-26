/* eslint-disable max-lines -- Keep failover admission, capability checks, and safe-boundary activation together so requests cannot bypass policy. */
import type {
  Model,
  ModelRequestDependencies,
  ModelRetryYieldDecision,
  ModelRetryYieldInput,
  ModelSelection,
  TraceContext,
} from "@zcode/contracts";
import type { ExecutionFailoverReasonCode } from "@zcode/shared/zcode-protocol-v4";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { prepareContextPrefixRefresh } from "./context-refresh.js";
import {
  ExecutionFailoverPreparedRollbackError,
  resolveRuntimeExecutionFailoverScope,
  sameExecutionModelSelection,
  type ExecutionFailoverPolicyTarget,
} from "./model-failover-policy.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { createTurnModel } from "./turn-model.js";

const MAX_EXECUTION_FAILOVER_TRANSITIONS = 2;
const NETWORK_REASONS = new Set([
  "network_error",
  "timeout",
  "stale_connection",
  "proxy_error",
  "tls_error",
]);
const SERVICE_REASONS = new Set(["provider_overloaded", "server_error"]);
const AUTH_ERROR_CODES = new Set(["model_request_auth_missing", "provider_not_configured"]);

export type ExecutionFailoverActivationResult = "activated" | "blocked" | "none";

export interface ExecutionFailoverRetryYieldClaim {
  consumedRetryAttempts: number;
  policyRevision?: number;
  sourceCommandId?: string;
}

export async function activateExecutionFailoverAtSafeBoundary(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    beforeActivate?: () => Promise<void>;
    reasonCode?: ExecutionFailoverReasonCode;
    traceContext?: TraceContext;
  } = {},
): Promise<ExecutionFailoverActivationResult> {
  const scope = resolveRuntimeExecutionFailoverScope(runtime);
  let beforeActivateCompleted = false;
  let accumulatedResult: ExecutionFailoverActivationResult = "none";
  while (true) {
    const before = runtime.executionFailoverPolicyPort.resolve(scope);
    let result: ExecutionFailoverActivationResult = "none";
    let activationError: unknown;
    try {
      result = await activateExecutionFailoverAtSafeBoundaryOnce(runtime, state, scope, {
        ...options,
        ...(options.beforeActivate && !beforeActivateCompleted
          ? {
              beforeActivate: async () => {
                await options.beforeActivate?.();
                beforeActivateCompleted = true;
              },
            }
          : { beforeActivate: undefined }),
      });
      accumulatedResult = mergeActivationResult(accumulatedResult, result);
    } catch (error) {
      activationError = error;
    }
    // Once 内部可能在当前 mutation 尚未释放时排入 B→C。等到尾部稳定后再读，
    // 才能保证本安全边界使用 latest-wins，且成功的 beforeActivate 不会重复执行。
    await runtime.executionFailoverPolicyPort.settle();
    const after = runtime.executionFailoverPolicyPort.resolve(scope);
    if (activationError instanceof ExecutionFailoverPreparedRollbackError) {
      throw activationError.rollbackCause;
    }
    if (after && before?.sourceCommandId !== after.sourceCommandId) {
      // latest-wins 仍受“本安全边界已访问/预算耗尽”约束；把目标留在 waiting，
      // 下一次干净边界再应用，不能把用户显式切回误记为永久 blocked。
      if (mustDeferTargetToNextSafeBoundary(state, after)) return accumulatedResult;
      continue;
    }
    if (activationError !== undefined) throw activationError;
    if (
      result === "none" &&
      after !== undefined &&
      after.status !== "blocked" &&
      !sameExecutionModelSelection(modelSelectionFromModel(state.model), after.modelSelection) &&
      !mustDeferTargetToNextSafeBoundary(state, after)
    ) {
      // retain/release 等同源 mutation 也会让旧 prepare 主动让位，但它没有替换模型目标。
      // 队列稳定后必须在本边界重试 B，否则调用方会拿 A 多发一次物理请求。
      continue;
    }
    return accumulatedResult;
    // 首次读取无策略时，Once 的快速返回仍会经过 await 微任务边界；B 可能恰在这里进入。
    // 无策略→B 与 B→C 都必须在本次请求边界继续解析，否则调用方会拿旧模型多发一次请求。
  }
}

function mustDeferTargetToNextSafeBoundary(
  state: RegularTurnLoopState,
  target: ExecutionFailoverPolicyTarget,
): boolean {
  return (
    state.executionFailoverUnsafePolicies.has(policyTargetKey(target)) ||
    state.executionFailoverTransitionCount >= MAX_EXECUTION_FAILOVER_TRANSITIONS ||
    state.executionFailoverVisitedModels.has(executionModelSelectionIdentity(target.modelSelection))
  );
}

function mergeActivationResult(
  accumulated: ExecutionFailoverActivationResult,
  current: ExecutionFailoverActivationResult,
): ExecutionFailoverActivationResult {
  if (accumulated === "activated" || current === "activated") return "activated";
  if (accumulated === "blocked" || current === "blocked") return "blocked";
  return "none";
}

async function activateExecutionFailoverAtSafeBoundaryOnce(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  scope: ReturnType<typeof resolveRuntimeExecutionFailoverScope>,
  options: {
    beforeActivate?: () => Promise<void>;
    reasonCode?: ExecutionFailoverReasonCode;
    traceContext?: TraceContext;
  },
): Promise<ExecutionFailoverActivationResult> {
  const target = runtime.executionFailoverPolicyPort.resolve(scope);
  if (!target || target.status === "blocked") return "none";
  if (state.executionFailoverUnsafePolicies.has(policyTargetKey(target))) return "none";

  const currentSelection = modelSelectionFromModel(state.model);
  if (sameExecutionModelSelection(currentSelection, target.modelSelection)) {
    if (target.status === "active") {
      const incompatibility = findTargetIncompatibility(
        state,
        target.modelSelection,
        state.model,
        options.reasonCode,
      );
      if (incompatibility) {
        await blockTarget(
          runtime,
          state,
          target,
          currentSelection,
          incompatibility,
          options.traceContext,
        );
        return "blocked";
      }
    }
    if (target.status !== "active") {
      await runtime.executionFailoverPolicyPort.complete(
        scope,
        options.traceContext ?? state.turnTraceContext,
      );
    }
    return "none";
  }

  if (target.status === "active") {
    let activeModel: Model;
    try {
      activeModel = createFailoverTurnModel(
        runtime,
        target.modelSelection,
        state.modelRequestDependencies,
      );
    } catch (error) {
      runtime.logger?.warn("Active execution failover target model could not be recreated", {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "model.failover.active_target_unavailable",
        modelId: target.modelSelection.modelId,
        module: "core.runtime",
        providerId: target.modelSelection.providerId,
      });
      await blockTarget(
        runtime,
        state,
        target,
        currentSelection,
        "target.model_unavailable",
        options.traceContext,
      );
      return "blocked";
    }
    const incompatibility = findTargetIncompatibility(
      state,
      target.modelSelection,
      activeModel,
      options.reasonCode,
    );
    if (incompatibility) {
      await blockTarget(
        runtime,
        state,
        target,
        currentSelection,
        incompatibility,
        options.traceContext,
      );
      return "blocked";
    }
    const application = createTargetModelApplication(
      runtime,
      state,
      activeModel,
      executionModelSelectionIdentity(target.modelSelection),
    );
    const applied = await runtime.executionFailoverPolicyPort.applyActive({
      commit: application.commit,
      prepare: async () => {
        await options.beforeActivate?.();
        await application.prepare();
      },
      rollbackPrepared: application.rollbackPrepared,
      scope,
      target,
    });
    return applied ? "activated" : "none";
  }

  const candidate = evaluateExecutionFailoverCandidate(runtime, state, target, {
    currentModel: state.model,
    entries: state.turnRequestState.entries,
    reasonCode: options.reasonCode,
    requestDependencies: state.modelRequestDependencies,
  });
  if (candidate.kind === "deferred") return "none";
  if (candidate.kind === "blocked") {
    if (candidate.reason === "target.model_unavailable") {
      runtime.logger?.warn("Execution failover target model could not be created", {
        event: "model.failover.target_unavailable",
        modelId: target.modelSelection.modelId,
        module: "core.runtime",
        providerId: target.modelSelection.providerId,
      });
    }
    await blockTarget(
      runtime,
      state,
      target,
      currentSelection,
      candidate.reason,
      options.traceContext,
    );
    return "none";
  }

  const targetKey = executionModelSelectionIdentity(target.modelSelection);
  const nextModel = candidate.model;
  const attempt = state.executionFailoverTransitionCount + 1;
  const application = createTargetModelApplication(runtime, state, nextModel, targetKey, attempt);
  const activated = await runtime.executionFailoverPolicyPort.activate({
    attempt,
    ...(options.beforeActivate ? { beforeActivate: options.beforeActivate } : {}),
    commit: application.commit,
    from: currentSelection,
    prepare: application.prepare,
    rollbackPrepared: application.rollbackPrepared,
    reasonCode: options.reasonCode ?? "userRequested",
    scope,
    target,
    traceContext: options.traceContext ?? state.turnTraceContext,
  });
  if (!activated) return "none";
  return "activated";
}

export async function blockExecutionFailoverTargetForModelCreationFailure(
  runtime: AgentRuntimeInternal,
  selection: ModelSelection,
  traceContext: TraceContext,
): Promise<boolean> {
  const scope = resolveRuntimeExecutionFailoverScope(runtime);
  const target = runtime.executionFailoverPolicyPort.resolve(scope);
  if (
    !target ||
    target.status === "blocked" ||
    !sameExecutionModelSelection(target.modelSelection, selection)
  ) {
    return false;
  }
  await runtime.executionFailoverPolicyPort.block({
    currentSelection: target.currentSelection ?? selection,
    reasonCode: "target.model_unavailable",
    scope,
    target,
    traceContext,
  });
  return true;
}

export function canActivateExecutionFailoverAtSafeBoundary(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  reasonCode?: ExecutionFailoverReasonCode,
): boolean {
  const target = runtime.executionFailoverPolicyPort.resolve(
    resolveRuntimeExecutionFailoverScope(runtime),
  );
  if (!target || target.status === "blocked") return false;
  return (
    evaluateExecutionFailoverCandidate(runtime, state, target, {
      currentModel: state.model,
      entries: state.turnRequestState.entries,
      reasonCode,
      requestDependencies: state.modelRequestDependencies,
    }).kind === "eligible"
  );
}

type ExecutionFailoverCandidate =
  | { kind: "eligible"; model: Model }
  | { kind: "deferred" }
  | { kind: "blocked"; reason: string };

function evaluateExecutionFailoverCandidate(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  target: ExecutionFailoverPolicyTarget,
  input: {
    currentModel: Model;
    entries: readonly (RuntimeMessageEntry | undefined)[];
    reasonCode?: ExecutionFailoverReasonCode;
    requestDependencies?: ModelRequestDependencies;
  },
): ExecutionFailoverCandidate {
  if (state.executionFailoverUnsafePolicies.has(policyTargetKey(target))) {
    return { kind: "deferred" };
  }
  if (
    sameExecutionModelSelection(modelSelectionFromModel(input.currentModel), target.modelSelection)
  ) {
    return { kind: "deferred" };
  }
  if (state.executionFailoverTransitionCount >= MAX_EXECUTION_FAILOVER_TRANSITIONS) {
    return { kind: "blocked", reason: "target.transition_budget_exhausted" };
  }
  if (
    state.executionFailoverVisitedModels.has(executionModelSelectionIdentity(target.modelSelection))
  ) {
    return { kind: "blocked", reason: "target.already_visited" };
  }

  let targetModel: Model;
  try {
    targetModel = createFailoverTurnModel(
      runtime,
      target.modelSelection,
      input.requestDependencies,
    );
  } catch {
    return { kind: "blocked", reason: "target.model_unavailable" };
  }
  const incompatibility = findModelTargetIncompatibility({
    currentModel: input.currentModel,
    entries: input.entries,
    model: targetModel,
    reasonCode: input.reasonCode,
    selection: target.modelSelection,
  });
  return incompatibility
    ? { kind: "blocked", reason: incompatibility }
    : { kind: "eligible", model: targetModel };
}

function createTargetModelApplication(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  model: Model,
  targetKey: string,
  transitionCount?: number,
): {
  commit: () => void;
  prepare: () => Promise<void>;
  rollbackPrepared: () => Promise<void>;
} {
  const selection = modelSelectionFromModel(model);
  const previousSelection = modelSelectionFromModel(state.model);
  let contextEntries = state.turnRequestState.entries;
  let commitContextPrefix = (): void => undefined;
  let durableSelectionPrepared = false;
  return {
    prepare: async () => {
      const contextRefresh = prepareContextPrefixRefresh(runtime, {
        model,
        turnRequestEntries: state.turnRequestState.entries,
      });
      if (runtime.executionFailoverScopeLifetime === "runtime") {
        // 持久 actor 的 journal 是下一次 ask 的事实来源；必须先成功写入，
        // 否则内存 selection / loop / registration 会形成不可重试的半提交。
        await runtime.executionFailoverSelectionSink?.(selection);
        durableSelectionPrepared = runtime.executionFailoverSelectionSink !== undefined;
      }
      contextEntries = contextRefresh.entries;
      commitContextPrefix = contextRefresh.commit;
    },
    commit: () => {
      commitContextPrefix();
      state.model = model;
      state.executionFailoverVisitedModels.add(targetKey);
      if (transitionCount !== undefined) {
        state.executionFailoverTransitionCount = transitionCount;
      }
      if (runtime.executionFailoverScopeLifetime === "runtime") {
        // 仅 runtime-lifetime child 写回自己的私有 selection，普通 subagent/profile 不受影响。
        runtime.setSessionModelSelection(selection);
      }
      runtime.activeForegroundExecution &&=
        runtime.executionFailoverScope === undefined
          ? {
              ...runtime.activeForegroundExecution,
              currentModelSelection: selection,
            }
          : runtime.activeForegroundExecution;
      // Adapter 统一请求入口会按 source/target model 只移除签名或 redacted 私有块，
      // 普通 reasoning 仍保留；Core 不复制 provider 原始请求，也不粗暴删除推理正文。
      state.turnRequestState.entries = contextEntries;
    },
    rollbackPrepared: async () => {
      if (!durableSelectionPrepared) return;
      // 最新目标在 journal B 后到达时，先补偿回安全边界起点 A；context 尚未 commit，
      // 因而无需回滚 message history。补偿失败必须向上传播并在物理请求前 fail closed。
      await runtime.executionFailoverSelectionSink?.(previousSelection);
      durableSelectionPrepared = false;
    },
  };
}

export async function shouldYieldRetryToExecutionFailover(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  model: Model,
  input: ModelRetryYieldInput,
  requestEntries: readonly (RuntimeMessageEntry | undefined)[] = [],
  requestDependencies?: ModelRequestDependencies,
): Promise<ModelRetryYieldDecision> {
  const reasonCode = classifyRetryYieldFailure(input);
  if (reasonCode === undefined || !input.retryable) return { shouldYield: false };
  return runtime.executionFailoverPolicyPort.decideRetryYield({
    evaluate: (target) =>
      target.status !== "blocked" &&
      evaluateExecutionFailoverCandidate(runtime, state, target, {
        currentModel: model,
        entries: requestEntries,
        reasonCode,
        requestDependencies,
      }).kind === "eligible",
    scope: resolveRuntimeExecutionFailoverScope(runtime),
  });
}

export function readExecutionFailoverRetryYieldClaim(
  error: unknown,
): ExecutionFailoverRetryYieldClaim | undefined {
  const context = asRecord(asRecord(error)?.context);
  if (context?.retryYieldedToFailover !== true) return undefined;
  const consumedRetryAttempts = numberValue(context.retryYieldConsumedRetryAttempts);
  if (
    consumedRetryAttempts === undefined ||
    !Number.isSafeInteger(consumedRetryAttempts) ||
    consumedRetryAttempts < 0
  ) {
    return undefined;
  }
  const policyRevision = numberValue(context.retryYieldPolicyRevision);
  const sourceCommandId = stringValue(context.retryYieldSourceCommandId);
  return {
    consumedRetryAttempts,
    ...(policyRevision === undefined ? {} : { policyRevision }),
    ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
  };
}

export function isExecutionFailoverRetryYieldClaimCurrent(
  runtime: AgentRuntimeInternal,
  claim: ExecutionFailoverRetryYieldClaim,
): boolean {
  const target = runtime.executionFailoverPolicyPort.resolve(
    resolveRuntimeExecutionFailoverScope(runtime),
  );
  return Boolean(
    target &&
    (claim.sourceCommandId === undefined || target.sourceCommandId === claim.sourceCommandId) &&
    (claim.policyRevision === undefined || target.revision === claim.policyRevision),
  );
}

function createFailoverTurnModel(
  runtime: AgentRuntimeInternal,
  selection: ModelSelection,
  requestDependencies?: ModelRequestDependencies,
): Model {
  // 构造与普通 Turn 共用同一惰性包装；预检不会调用 Model，因此不会提前解析账号凭据。
  return createTurnModel(runtime, {
    rawModelFactory: runtime.failoverModelFactory,
    requestDependencies,
    selection,
  });
}

export function classifyExecutionFailoverFailure(
  error: unknown,
  abortSignal?: AbortSignal,
): ExecutionFailoverReasonCode | undefined {
  if (abortSignal?.aborted) return undefined;
  for (const record of walkErrorRecords(error)) {
    const context = asRecord(record.context);
    const reason = stringValue(record.reason) ?? stringValue(context?.reason);
    const code = stringValue(record.code) ?? stringValue(context?.code);
    const statusCode = numberValue(record.statusCode) ?? numberValue(context?.statusCode);
    const classified = classifyStructuredFailure({ code, reason, statusCode });
    if (classified) return classified;
  }
  return undefined;
}

export function hasExecutionFailoverTarget(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): boolean {
  const target = runtime.executionFailoverPolicyPort.resolve(
    resolveRuntimeExecutionFailoverScope(runtime),
  );
  return Boolean(
    target &&
    target.status !== "blocked" &&
    !state.executionFailoverUnsafePolicies.has(policyTargetKey(target)) &&
    !sameExecutionModelSelection(modelSelectionFromModel(state.model), target.modelSelection),
  );
}

export function markExecutionFailoverUnsafe(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): void {
  const target = runtime.executionFailoverPolicyPort.resolve(
    resolveRuntimeExecutionFailoverScope(runtime),
  );
  if (target) state.executionFailoverUnsafePolicies.add(policyTargetKey(target));
}

export function modelSelectionFromModel(model: Model): ModelSelection {
  const reasoningLevel = model.options.reasoningLevel;
  const speed = model.options.speed;
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    ...(reasoningLevel || speed
      ? {
          options: {
            ...(reasoningLevel ? { reasoningLevel } : {}),
            ...(speed ? { speed } : {}),
          },
        }
      : {}),
  };
}

function classifyRetryYieldFailure(
  input: ModelRetryYieldInput,
): ExecutionFailoverReasonCode | undefined {
  return classifyStructuredFailure({
    code: input.errorCode,
    reason: input.reason,
    statusCode: input.statusCode,
  });
}

function classifyStructuredFailure(input: {
  code?: string;
  reason?: string;
  statusCode?: number;
}): ExecutionFailoverReasonCode | undefined {
  if (input.reason === "cancelled" || input.reason === "invalid_request") return undefined;
  if (input.reason === "context_exceeded") return "provider.context_capacity";
  if (input.reason === "stream_idle_timeout") return "provider.stream_unrecoverable";
  if (NETWORK_REASONS.has(input.reason ?? "")) return "network.transport_unavailable";
  if (SERVICE_REASONS.has(input.reason ?? "")) return "provider.service_unavailable";
  if (input.reason === "rate_limited" || input.statusCode === 429) {
    return "provider.rate_limited";
  }
  if (input.reason === "auth_failed" || AUTH_ERROR_CODES.has(input.code ?? "")) {
    return "provider.authentication_failed";
  }
  if (input.statusCode !== undefined && input.statusCode >= 500) {
    return "provider.service_unavailable";
  }
  return undefined;
}

async function blockTarget(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  target: ExecutionFailoverPolicyTarget,
  currentSelection: ModelSelection,
  reasonCode: string,
  traceContext?: TraceContext,
): Promise<void> {
  await runtime.executionFailoverPolicyPort.block({
    currentSelection,
    reasonCode,
    scope: resolveRuntimeExecutionFailoverScope(runtime),
    target,
    traceContext: traceContext ?? state.turnTraceContext,
  });
}

function findTargetIncompatibility(
  state: RegularTurnLoopState,
  selection: ModelSelection,
  model: Model,
  reasonCode?: ExecutionFailoverReasonCode,
): string | undefined {
  return findModelTargetIncompatibility({
    currentModel: state.model,
    entries: state.turnRequestState.entries,
    model,
    reasonCode,
    selection,
  });
}

function findModelTargetIncompatibility(input: {
  currentModel: Model;
  entries: readonly (RuntimeMessageEntry | undefined)[];
  model: Model;
  reasonCode?: ExecutionFailoverReasonCode;
  selection: ModelSelection;
}): string | undefined {
  const { currentModel, entries, model, reasonCode, selection } = input;
  if (model.providerId !== selection.providerId || model.modelId !== selection.modelId) {
    return "target.identity_mismatch";
  }
  if (
    selection.options?.reasoningLevel !== undefined &&
    model.options.reasoningLevel !== selection.options.reasoningLevel
  ) {
    return "target.reasoning_level_unsupported";
  }
  if (selection.options?.speed !== undefined && model.options.speed !== selection.options.speed) {
    return "target.speed_unsupported";
  }
  if (currentModel.properties.supportsToolCall && !model.properties.supportsToolCall) {
    return "target.tools_unsupported";
  }
  if (model.properties.contextWindow < currentModel.properties.contextWindow) {
    return "target.context_capacity_lower";
  }
  const requiredInput = requiredInputCapabilities(entries);
  if (
    (requiredInput.image && !model.properties.inputFormat.supportsImage) ||
    (requiredInput.video && !model.properties.inputFormat.supportsVideo) ||
    (requiredInput.audio && !model.properties.inputFormat.supportsAudio) ||
    (requiredInput.pdf && !model.properties.inputFormat.supportsPdf)
  ) {
    return "target.input_unsupported";
  }
  if (
    reasonCode === "provider.context_capacity" &&
    model.properties.contextWindow <= currentModel.properties.contextWindow
  ) {
    return "target.context_not_larger";
  }
  return undefined;
}

function requiredInputCapabilities(entries: readonly (RuntimeMessageEntry | undefined)[]): {
  audio: boolean;
  image: boolean;
  pdf: boolean;
  video: boolean;
} {
  const required = { audio: false, image: false, pdf: false, video: false };
  for (const entry of entries) {
    if (!entry) continue;
    if (entry.kind === "attachment" || !Array.isArray(entry.message.content)) continue;
    for (const block of entry.message.content) {
      if (!block || typeof block !== "object" || !("type" in block)) continue;
      if (block.type === "image") required.image = true;
      if (block.type === "video") required.video = true;
      if (block.type === "file") {
        const mediaType = block.mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
        if (mediaType === "application/pdf") required.pdf = true;
        if (mediaType.startsWith("audio/")) required.audio = true;
        if (mediaType.startsWith("image/")) required.image = true;
        if (mediaType.startsWith("video/")) required.video = true;
      }
    }
  }
  return required;
}

export function executionModelSelectionIdentity(selection: ModelSelection): string {
  return [
    selection.providerId,
    selection.modelId,
    selection.options?.reasoningLevel ?? "",
    selection.options?.speed ?? "",
  ].join("\0");
}

function policyTargetKey(target: ExecutionFailoverPolicyTarget): string {
  // unsafe fence 绑定实际 execution target；新命令只替换意图，不能解除本轮尚未收口的工具副作用。
  return `${target.kind}\0${target.id}`;
}

function* walkErrorRecords(error: unknown): Generator<Record<string, unknown>> {
  let current = error;
  const seen = new WeakSet<object>();
  for (let depth = 0; depth <= 6; depth += 1) {
    const record = asRecord(current);
    if (!record || seen.has(record)) return;
    seen.add(record);
    yield record;
    current = record.cause;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
