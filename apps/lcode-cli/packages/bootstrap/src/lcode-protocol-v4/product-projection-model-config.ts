// 模型配置与 context 容量种子/事件写入，保留日志优先和未知容量语义。
// host 是 ProductProjection 原实例的窄借用视图；函数不持有副本或另建 owner。
import type {
  ProductProjectionState,
  SessionConfigSeed,
  SessionUsageSeed,
} from "./product-projection-state.js";
import type { SessionEvent, ModelSelectedPayload } from "@lcode/contracts";
import type { ConversationDelta } from "@lcode/shared/lcode-protocol-v4";
import { HYDRATION_TRACE_ID } from "./projection-state.js";

type SeedConfigHost = Pick<
  ProductProjectionState,
  | "snapshot"
  | "configModelTouchedByEvent"
  | "configThoughtLevelsTouchedByEvent"
  | "configModeTouchedByEvent"
>;

type SeedUsageHost = Pick<ProductProjectionState, "snapshot" | "contextWindowState">;

type ModelSelectedHost = Pick<
  ProductProjectionState,
  | "snapshot"
  | "contextWindowState"
  | "lastTurnModel"
  | "configModelTouchedByEvent"
  | "configThoughtLevelsTouchedByEvent"
>;

/**
 * config 种子注入。
 *
 * 初始快照 config 曾写死空 provider/model +
 * mode="build"，而 ModelSelected 只在 switchModelConfig 后补发、SessionCreated 刻意
 * 不产 delta——runtime 真值（启动默认模型/项目持久化 mode/历史会话上次选型）从头到尾
 * 进不了投影。后果：① 新会话模型选择器显示空；② 项目持久化 mode=yolo 时 UI 显示
 * build，点 yolo 命中 handler 同值 no-op（判的是 runtime 真值），UI 永远无法收敛——
 * 打破了「revision 不变 ⇔ 无状态变化」的 CAS 不变量。
 *
 * 为什么这么修：种子直改 snapshot.config，不产 delta、不递增 revision/seq——
 * draft「无可见 delta」裁决不被破坏；事件触碰过的区块跳过（重放序
 * 在种子之后时日志值优先）。幂等：可在 ensurePublisher / hydration 后重复调用。
 */
export function seedConfig(host: SeedConfigHost, seed: SessionConfigSeed): void {
  if (seed.executionWorkspace) {
    host.snapshot = { ...host.snapshot, executionWorkspace: { ...seed.executionWorkspace } };
  }
  const config = { ...host.snapshot.config };
  let changed = false;
  if (!config.permissionGrant && seed.permissionGrant) {
    config.permissionGrant = seed.permissionGrant;
    changed = true;
  }
  if (!host.configModelTouchedByEvent) {
    if (
      Object.hasOwn(seed, "modelSelection") &&
      !sameSparseModelSelection(config.modelSelection, seed.modelSelection)
    ) {
      // 恢复的空选择也有明确语义，不能因为 falsy 而保留历史事件里的旧选型。
      config.modelSelection = seed.modelSelection
        ? cloneSparseModelSelection(seed.modelSelection)
        : undefined;
      changed = true;
    }
    if (seed.provider !== undefined && config.provider !== seed.provider) {
      config.provider = seed.provider;
      changed = true;
    }
    if (seed.model !== undefined && config.model !== seed.model) {
      config.model = seed.model;
      changed = true;
    }
    if (seed.thought !== undefined && config.thought !== seed.thought) {
      config.thought = seed.thought;
      changed = true;
    }
  }
  const seedThoughtLevels = seed.thoughtLevels;
  if (
    !host.configThoughtLevelsTouchedByEvent &&
    seedThoughtLevels !== undefined &&
    (config.thoughtLevels.length !== seedThoughtLevels.length ||
      config.thoughtLevels.some((value, index) => value !== seedThoughtLevels[index]))
  ) {
    config.thoughtLevels = [...seedThoughtLevels];
    changed = true;
  }
  if (!host.configModeTouchedByEvent && seed.mode && config.mode !== seed.mode) {
    config.mode = seed.mode;
    changed = true;
  }
  if (
    !host.configModeTouchedByEvent &&
    seed.planEnabled !== undefined &&
    config.planEnabled !== seed.planEnabled
  ) {
    config.planEnabled = seed.planEnabled;
    changed = true;
  }
  if (changed) {
    host.snapshot = { ...host.snapshot, config };
  }
}

export function seedUsage(host: SeedUsageHost, seed: SessionUsageSeed): void {
  const current = host.snapshot.usage;
  const currentContextWindow = current.contextWindow;
  // 子会话 ModelComplete 也可实时入账；迟到的冷种子不能覆盖已确认的 live 累计。
  if (current.cumulative.inputTokens > 0 || current.cumulative.outputTokens > 0) return;
  if (currentContextWindow) {
    host.contextWindowState.usedTokens = currentContextWindow.usedTokens;
  }
  // 未知容量也有内部用量事实；迟到的恢复种子不能覆盖真实 ModelComplete/Compact 水位。
  if (host.contextWindowState.usedTokens > 0) {
    return;
  }
  const seededContextWindow = seed.contextWindow;
  if (!Number.isFinite(seededContextWindow.usedTokens) || seededContextWindow.usedTokens <= 0) {
    if (seed.cumulative) {
      host.snapshot = {
        ...host.snapshot,
        usage: { ...current, cumulative: { ...current.cumulative, ...seed.cumulative } },
      };
    }
    return;
  }
  const cumulative = {
    inputTokens: seed.cumulative?.inputTokens ?? current.cumulative.inputTokens,
    outputTokens: seed.cumulative?.outputTokens ?? current.cumulative.outputTokens,
    cacheReadTokens: seed.cumulative?.cacheReadTokens ?? current.cumulative.cacheReadTokens,
    cacheWriteTokens: seed.cumulative?.cacheWriteTokens ?? current.cumulative.cacheWriteTokens,
  };
  if (host.contextWindowState.touchedByEvent) {
    // 同类守卫：显式 ModelSelected.contextWindow（含 null）是日志权威容量，
    // hydration seed 只能补回更准确的 token 事实，不得覆盖 maxTokens 或重新显示 null。
    host.contextWindowState.usedTokens = seededContextWindow.usedTokens;
    host.snapshot = {
      ...host.snapshot,
      usage: {
        ...current,
        contextWindow: currentContextWindow
          ? {
              ...currentContextWindow,
              usedTokens: seededContextWindow.usedTokens,
            }
          : null,
        cumulative,
      },
    };
    return;
  }
  if (
    seededContextWindow.maxTokens !== null &&
    (!Number.isFinite(seededContextWindow.maxTokens) || seededContextWindow.maxTokens <= 0)
  ) {
    return;
  }

  // 合成历史事件只有零用量占位；种子补真实水位，未知容量不妨碍内部保留 token。
  host.contextWindowState.usedTokens = seededContextWindow.usedTokens;
  host.contextWindowState.maxTokens = seededContextWindow.maxTokens;
  host.snapshot = {
    ...host.snapshot,
    usage: {
      ...current,
      contextWindow:
        seededContextWindow.maxTokens === null
          ? null
          : { ...seededContextWindow, maxTokens: seededContextWindow.maxTokens },
      cumulative,
    },
  };
}

export function onModelSelected(host: ModelSelectedHost, event: SessionEvent): ConversationDelta[] {
  const payload = event.payload as ModelSelectedPayload;
  // Bug 原因：把 fresh child 身份另存为 pending side state 后，原子投影 clone/adopt
  // 漏复制该字段，实时 marker 会消失。显式 null 直接复用模型基线表达 ∅→X，
  // 公共投影不再识别 Subagent 身份；后续选型只更新 config，不覆盖上一轮实际模型。
  if (payload.previousModelSelection === null) {
    host.lastTurnModel = { kind: "sourceLess" };
  }
  const prev = host.snapshot.config;
  const provider = payload.modelSelection.providerId;
  const model = payload.modelSelection.modelId;
  const thought =
    payload.effectiveReasoningLevel ?? payload.modelSelection.options?.reasoningLevel ?? "";
  const modelSelection = cloneSparseModelSelection(payload.modelSelection);
  const thoughtLevels = payload.supportedThoughtLevels
    ? [...payload.supportedThoughtLevels]
    : prev.thoughtLevels;
  const contextWindow =
    payload.contextWindow === null
      ? null
      : payload.contextWindow !== undefined
        ? positiveInteger(payload.contextWindow, 0) || undefined
        : undefined;
  // Bug 原因：旧事件只更新 config，runtime 虽已切到新模型，历史 usage 的 maxTokens
  // 仍停在源模型，直到下一次 ModelComplete 才偶然校准。窗口属于已应用模型能力，
  // 必须在同一个 ModelSelected 中提交；usedTokens 仍保留历史上下文事实。
  if (contextWindow !== undefined) {
    host.contextWindowState.touchedByEvent = true;
    host.contextWindowState.maxTokens =
      contextWindow !== null && contextWindow > 0 ? contextWindow : null;
  }
  const previousContextWindow = host.snapshot.usage.contextWindow;
  if (previousContextWindow) {
    host.contextWindowState.usedTokens = previousContextWindow.usedTokens;
  }
  const contextWindowChanged =
    contextWindow !== undefined &&
    (contextWindow === null
      ? previousContextWindow !== null
      : previousContextWindow === null || previousContextWindow.maxTokens !== contextWindow);
  // 日志事件触碰过模型选型后，种子不再覆盖（同值 return 也算触碰）。
  // 冷恢复合成的 ModelSelected（HYDRATION_TRACE_ID）例外：它只是从 message 事实
  // 重建历史选型供 modelChange marker 使用，不是权威选型动作；重放后 seedConfig
  // 仍以 runtime 真值（resume 已回写的上次/草稿选型）收口。
  if (String(event.traceId) !== HYDRATION_TRACE_ID) {
    host.configModelTouchedByEvent = true;
    if (payload.supportedThoughtLevels !== undefined) {
      host.configThoughtLevelsTouchedByEvent = true;
    }
  }
  // 选型事件只更新 config，不在选型时落 modelChange
  // marker——切换动作是意向，marker 归 onTurnStarted 按「与上一轮实际选型不同」
  // 裁决（见彼处注释与 Bug 背景）。
  const configChanged = !(
    prev.provider === provider &&
    prev.model === model &&
    sameSparseModelSelection(prev.modelSelection, modelSelection) &&
    prev.thought === thought &&
    prev.thoughtLevels.length === thoughtLevels.length &&
    prev.thoughtLevels.every((value, index) => value === thoughtLevels[index])
  );
  const modelTransition =
    payload.origin === "registryFallback" &&
    payload.previousModelSelection != null &&
    (payload.previousModelSelection.providerId !== provider ||
      payload.previousModelSelection.modelId !== model)
      ? {
          eventId: String(event.id),
          origin: payload.origin,
          from: {
            provider: payload.previousModelSelection.providerId,
            model: payload.previousModelSelection.modelId,
          },
          to: { provider, model },
        }
      : undefined;
  if (!configChanged && !contextWindowChanged && modelTransition === undefined) {
    return [];
  }
  return [
    {
      op: "state.updated",
      patch: {
        ...(configChanged
          ? { config: { ...prev, modelSelection, provider, model, thought, thoughtLevels } }
          : {}),
        // Bug 原因：仅投影 config 会丢失“由 registry fallback 触发”的来源，
        // renderer 无法安全地区分自动恢复和显式/历史切换。保留事件 ID 与起止身份，
        // 具体 toast 仍只由客户端在实时 online delivery 边界触发。
        ...(modelTransition ? { modelTransition } : {}),
        ...(contextWindowChanged
          ? {
              usage: {
                ...host.snapshot.usage,
                // Bug 原因：null 是 registry 清除显式窗口的权威事件，必须清空整个
                // usage.contextWindow；字段缺失才保留旧事件兼容语义。
                contextWindow:
                  contextWindow === null
                    ? null
                    : previousContextWindow
                      ? { ...previousContextWindow, maxTokens: contextWindow }
                      : {
                          usedTokens: host.contextWindowState.usedTokens,
                          maxTokens: contextWindow,
                          autoCompactThresholdTokens: null,
                        },
              },
            }
          : {}),
      },
    },
  ];
}

function cloneSparseModelSelection(
  selection: ModelSelectedPayload["modelSelection"],
): ModelSelectedPayload["modelSelection"] {
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.options ? { options: { ...selection.options } } : {}),
  };
}

function sameSparseModelSelection(
  left: ModelSelectedPayload["modelSelection"] | undefined,
  right: ModelSelectedPayload["modelSelection"] | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.options?.reasoningLevel === right.options?.reasoningLevel &&
    left.options?.speed === right.options?.speed
  );
}

export function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
