/** Workflow actor 模型绑定的稳定来源；只有 sessionInherited 可跟随父执行切换。 */
export type ActorModelProvenance =
  | "approvedActorOverride"
  | "scriptActorModel"
  | "runModel"
  | "resumePin"
  | "sessionInherited";

/** run 默认模型只允许显式选择或继承会话；其它来源属于单 actor 绑定。 */
export type WorkflowRunModelProvenance = Extract<
  ActorModelProvenance,
  "runModel" | "sessionInherited"
>;

/** 宿主与 workflow runtime 之间传递的完整模型选择。 */
export interface WorkflowModelSelection {
  providerId: string;
  modelId: string;
  options?: {
    reasoningLevel?: string;
    speed?: string;
  };
}

/** 单个 actor 的显式模型覆盖。 */
export interface WorkflowActorModelOverride {
  /** Static agent() call site. */
  siteId?: string;
  /** Runtime actor identity; useful when the call site is shared by dynamic branches. */
  name?: string;
  /** Concrete fan-out instance. Omit to target every instance matched by site/name. */
  ordinal?: number;
  selection: WorkflowModelSelection;
}

/** actor 的冻结身份；模型字段是脚本显式默认值，不是持久运行态。 */
export interface PersonaSpec {
  name?: string;
  system?: string;
  /** Script-authored default; an approved run override takes precedence. */
  model?: WorkflowModelSelection;
}

/** journal 与 import seed 共同使用的原子模型绑定。 */
export interface ActorModelBinding {
  /** 实际模型的 continuation 起点；自身不构成来源证据。 */
  resolvedModel?: string;
  /** 与 resolvedModel 同行持久化；缺席只表示升级前的旧记录。 */
  modelProvenance?: ActorModelProvenance;
}

/** 整行替换 actor 记录时，始终把 selection 与 provenance 作为一个绑定复制。 */
export function actorModelBindingOf(source: ActorModelBinding | undefined): ActorModelBinding {
  return {
    resolvedModel: source?.resolvedModel,
    modelProvenance: source?.modelProvenance,
  };
}
