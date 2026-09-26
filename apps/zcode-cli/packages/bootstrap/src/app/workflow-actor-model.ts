// ============================================================
// workflow actor 的模型面（显式配置 / 持久绑定 / import seed → AgentRuntime 模型配置）
// ============================================================
//
// persona 的模型档位（`model?: "main" | "lite"`）已退场。宿主在 provider 重构后没有 lite 模型来源，
// "lite" 与 "main" 早已同路——继承父会话当前模型。
//
// 本模块把五类稳定 provenance（approved/script/run/resumePin/sessionInherited）归约成两个事实：
// actor 创建时是否覆盖父模型，以及它是否有资格跟随父 execution failover。
// 与 workflow-actor-tools.ts 是同一个接缝上的姊妹模块：一个给出工具面，一个给出模型面，
// 都由 driver 侧的 runtime 工厂在造 AgentRuntime 时展开。

import type {
  ActorModelProvenance,
  WorkflowRunModelProvenance,
} from "@zcode/dynamic-workflow";
import { modelSelectionSchema, type ModelSelection } from "@zcode/shared/model-selection";
import { parseProviderQualifiedModelSelection } from "./provider-registry-selection.js";

/** 解析模型面需要的宿主侧事实。 */
interface WorkflowActorModelHost {
  /**
   * 本 run 自己的子代理模型（`CreateWorkflow` / `AmendWorkflow` 的 `subagent_model`，从 journal
   * 的 `run-launched` 事件读回）。**整条选择**，含 reasoning
   * 档位——用户说「子代理跑 GLM-5.3-Flash$high」时那个档位是选择的一部分，不能在这里掉。
   *
   * 它是用户对这一次 run 的显式表态；主代理不受它影响——它只描述子代理。
   */
  runSelection?: ModelSelection | undefined;
  /** 新 launch 的显式 provenance；sessionInherited 只屏蔽 imported seed，不覆盖同 run 绑定。 */
  runProvenance?: WorkflowRunModelProvenance | undefined;
  /** Script-authored default from agent(..., { model }). */
  scriptSelection?: ModelSelection | undefined;
  /** User-approved actor override. */
  approvedSelection?: ModelSelection | undefined;
}

/** AgentRuntimeConfig 的模型面切片。 */
export type WorkflowActorModelProvenance = ActorModelProvenance;

/** resolvedModel 与来源在 journal/seed 中必须作为一个绑定事实同行传播。 */
export interface WorkflowActorModelBinding {
  resolvedModel: string;
  modelProvenance?: ActorModelProvenance;
}

export interface WorkflowActorExecutionFailoverScope {
  backgroundWorkId: string;
  foregroundExecutionId: string;
}

interface WorkflowActorModelPolicy {
  /**
   * 展开进 AgentRuntimeConfig 的覆盖项。**空对象即「不覆盖」**：child runtime 的基线本就是
   * 父会话的模型选择（script-workflow-child-runtime.ts），所以 sessionInherited 的全新 actor
   * 或 inherited seed 什么都不写，就是从父会话当前选择开始。
   */
  configOverrides: {
    modelSelection?: ModelSelection;
  };
  /**
   * 模型选择的权威来源。只有 `sessionInherited` 能跟随父执行做安全边界切换；其余来源都是
   * workflow 自己的显式/持久化约束，父会话切换不能覆盖。
   */
  provenance: WorkflowActorModelProvenance;
}

/**
 * 持久绑定无法解析时抛出。保留旧类名与字段，兼容已经按 resume pin 识别该错误的调用方。
 */
export class WorkflowActorPinnedModelError extends Error {
  readonly pinnedModel: string;

  constructor(pinnedModel: string, cause?: unknown) {
    super(`Cannot construct the model pinned for this subagent: ${pinnedModel}`);
    this.name = "WorkflowActorPinnedModelError";
    this.pinnedModel = pinnedModel;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * 把显式配置、同 run 持久绑定与 import seed 映射成 AgentRuntime 的模型配置。纯函数。
 *
 * `persistedBinding` 是这个 actor 在**本 run** journal 里的完整模型绑定。新记录使用
 * `selection:<完整 ModelSelection JSON>`，旧记录仍兼容 `providerId/modelId`。`inheritedSeedBinding`
 * 来自 amend 导入的前驱 transcript；只有它自己带着显式/pin provenance 时才保持固定。
 *
 * 优先级：**批准的 actor 覆盖 > 脚本 actor 默认 > 本 run 显式选择 > 同 run 持久绑定 >
 * import seed > 父会话基线**。
 *
 * | 证据 | 创建选择 | provenance |
 * |---|---|---|
 * | approved / script / run 配置 | 该完整显式选择 | 对应显式来源 |
 * | 同 run 持久绑定 | journal selection continuation | journal provenance；旧 NULL 按 sessionInherited |
 * | import seed 为 sessionInherited 或旧 NULL | 不覆盖父会话当前选择 | sessionInherited |
 * | import seed 为 explicit / resumePin | seed selection | seed 原 provenance |
 * | 全部缺席 | 不覆盖父会话当前选择 | sessionInherited |
 *
 * `resolvedModel` 自身不是来源证据。特别是旧行 provenance 为 NULL 时，没有上述显式配置便按
 * sessionInherited 解释；同 run 的 selection 仍作为 continuation 起点使用，但不会升级成 resumePin。
 * import seed 更严格：sessionInherited seed 的 selection 只描述前驱 transcript，不能覆盖父会话
 * 已切换后的当前选择。所有被采用的持久 selection 若格式无效都大声失败，不猜 provider 或降级。
 *
 * 本函数**不产出**「最终跑在哪个模型上」这条事实：它要落 journal，而权威是造出来的 child
 * runtime 自己（`runtime.getSessionModelSelection()`）。让 runtime 来说，就不会出现「策略以为
 * 选了 A、runtime 实际跑着 B」这类两处各算一遍才会有的偏差。落库见
 * dynamic-workflow-run-launch.ts 的 `journalActorResolvedModel`。
 */
export function workflowActorModelPolicy(
  host: WorkflowActorModelHost,
  persistedBinding?: WorkflowActorModelBinding,
  inheritedSeedBinding?: WorkflowActorModelBinding,
): WorkflowActorModelPolicy {
  if (host.approvedSelection !== undefined) {
    return {
      configOverrides: { modelSelection: host.approvedSelection },
      provenance: "approvedActorOverride",
    };
  }
  if (host.scriptSelection !== undefined) {
    return {
      configOverrides: { modelSelection: host.scriptSelection },
      provenance: "scriptActorModel",
    };
  }
  // 显式 run 选择在场时整条覆盖，旧持久绑定连解析都不解析。
  if (host.runSelection !== undefined) {
    return { configOverrides: { modelSelection: host.runSelection }, provenance: "runModel" };
  }
  if (persistedBinding !== undefined) {
    const selection = parseRecordedModel(persistedBinding.resolvedModel);
    // 旧 NULL 行不能仅凭 resolvedModel 猜成 pin：没有显式配置证据时按继承解释。
    const provenance = persistedBinding.modelProvenance ?? "sessionInherited";
    return { configOverrides: { modelSelection: selection }, provenance };
  }
  if (host.runProvenance === "sessionInherited") {
    return { configOverrides: {}, provenance: "sessionInherited" };
  }
  if (inheritedSeedBinding !== undefined) {
    const provenance = inheritedSeedBinding.modelProvenance ?? "sessionInherited";
    if (provenance === "sessionInherited") {
      // 继承 seed 的 resolvedModel 只描述前驱 transcript；父会话已到 B 时不能先跑一次 A。
      return { configOverrides: {}, provenance };
    }
    return {
      configOverrides: {
        modelSelection: parseRecordedModel(inheritedSeedBinding.resolvedModel),
      },
      provenance,
    };
  }
  return { configOverrides: {}, provenance: "sessionInherited" };
}

/**
 * 把 workflow 模型来源收窄成运行期接管 scope。runId 不能作为 work id：同一个 run 内可以同时
 * 存在显式模型与继承模型的 actor；childSessionId 才是逐 actor、跨 resume 稳定的身份。
 */
export function workflowActorExecutionFailoverScope(input: {
  childSessionId: string;
  foregroundExecutionId?: string;
  provenance: WorkflowActorModelProvenance;
}): WorkflowActorExecutionFailoverScope | undefined {
  if (input.provenance !== "sessionInherited" || input.foregroundExecutionId === undefined) {
    return undefined;
  }
  return {
    backgroundWorkId: input.childSessionId,
    foregroundExecutionId: input.foregroundExecutionId,
  };
}

/**
 * 解析 journal/seed 里的选择。新格式保留完整 options；旧 `providerId/modelId` 格式继续兼容。
 * 两种格式都**不带默认 provider**：缺 provider 就意味着记录无效，不能拿父会话 provider 猜身份。
 */
function parseRecordedModel(recordedModel: string): ModelSelection {
  if (recordedModel.startsWith("selection:")) {
    try {
      const parsed = modelSelectionSchema.safeParse(
        JSON.parse(recordedModel.slice("selection:".length)),
      );
      if (parsed.success) return parsed.data;
    } catch {
      // 下面统一抛出带原始记录的错误，避免 JSON 解析细节泄漏成另一种失败形态。
    }
    throw new WorkflowActorPinnedModelError(recordedModel);
  }
  const parsed = parseProviderQualifiedModelSelection(recordedModel);
  if (parsed === undefined) throw new WorkflowActorPinnedModelError(recordedModel);
  return parsed;
}
