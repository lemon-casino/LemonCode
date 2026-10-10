import { resolveEffectiveBashShellSelection } from "@lcode/adapters/exec";
import { AgentRuntime, type ResumeSessionResult } from "@lcode/core";
import { type TraceContext, type ExecutionShellSelection } from "@lcode/contracts";
import type { PrepareUserExecutionBoundary, ResumeOptions } from "./types.js";
import { readSessionModelSelection } from "./session-store.js";
import type { SessionStorePort } from "@lcode/contracts";
import type { AppStartupContext } from "./app-startup-context.js";

export function createAppSessionResume(input: {
  startup: Pick<AppStartupContext, "options" | "sessionId" | "traceContext" | "logger">;
  sessionStore: SessionStorePort;
  getRuntime(): AgentRuntime;
}) {
  const { options, sessionId, traceContext, logger } = input.startup;
  const { sessionStore, getRuntime } = input;
  let resumePrepared = false;
  const resolveDefaultShellSelection = (): ExecutionShellSelection =>
    resolveEffectiveBashShellSelection({
      env: options.env ?? process.env,
      platform: options.platform ?? process.platform,
    }).selection;
  // 首次结果缓存曾使所有后续任务沿用旧设置；解析属于任务边界，由 Runtime 统一应用。
  const resolveSessionShellSelection = async (
    executionTrace: TraceContext,
  ): Promise<ExecutionShellSelection> =>
    (await options.resolveBashShellSelection?.(executionTrace)) ??
    options.runtimeConfig?.bashShellSelection ??
    resolveDefaultShellSelection();

  const restorePersistedModelSelection = async (): Promise<
    ResumeSessionResult["modelSelection"]
  > => {
    const registry = options.providerRegistry;
    let selection: ResumeSessionResult["modelSelection"];
    try {
      // 数据库启动已完成版本化迁移；恢复只读新字段，不按会话重复补迁。
      selection = await readSessionModelSelection(sessionStore, sessionId);
    } catch (error) {
      // 选择 entry 的读取/解析故障不能拖垮独立的历史恢复；留下真实存储错误，
      // 不读取旧消息或默认模型来掩盖失败。
      logger.warn("Session model selection restore failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "session.model_selection.restore_failed",
        sessionId,
      });
    }
    const validation = selection && registry.validateSelection(selection);
    // 只查模型是否存在会把缺档位/已删除的选择重新绑定进 Runtime，
    // 抵消了未绑定初始化。历史恢复不要求可执行模型，只有完整选择可以绑定。
    getRuntime().setSessionModelSelection(validation?.ok ? selection : undefined);
    // 恢复结果是保存意图，不是执行绑定。过去在这里置空/删档位，Host 的
    // Selection View 就再也拿不到原意图，账号切换和配置恢复后也无法重新解析。
    return selection;
  };

  const resumeFromStore = async (resumeOptions?: ResumeOptions): Promise<ResumeSessionResult> => {
    const runtime = getRuntime();
    const unsubscribe = resumeOptions?.onEvent
      ? runtime.subscribeEvents({ onSessionEvent: resumeOptions.onEvent })
      : undefined;

    try {
      const resumeTraceContext = resumeOptions?.traceContext ?? traceContext;
      const modelSelection = await restorePersistedModelSelection();
      await runtime.prepareSessionShellEnvironment(resumeTraceContext, resumeOptions?.abortSignal);
      const result = await runtime.resumeFromStore({
        ...(resumeOptions?.abortSignal ? { abortSignal: resumeOptions.abortSignal } : {}),
        // 只传调用方原始 mode；项目/全局默认值不能伪装成 invocation override，
        // 否则交互式 resume 将无法恢复真正持久化的 session mode。
        modeOverride: options.runtimeConfig?.mode,
        persistedMessages: resumeOptions?.persistedMessages,
        traceContext: resumeTraceContext,
      });
      await runtime.activatePausedTargetAfterResume(resumeTraceContext);
      resumePrepared = true;
      return { ...result, modelSelection };
    } finally {
      unsubscribe?.();
    }
  };

  const prepareResume = async (
    submitTraceContext?: TraceContext,
    abortSignal?: AbortSignal,
  ): Promise<void> => {
    if (!options.resume || resumePrepared) return;
    await resumeFromStore({
      ...(abortSignal ? { abortSignal } : {}),
      traceContext: submitTraceContext ?? traceContext,
    });
    resumePrepared = true;
  };

  const prepareUserExecutionBoundary: PrepareUserExecutionBoundary = async (boundaryOptions) => {
    await prepareResume(boundaryOptions?.traceContext, boundaryOptions?.abortSignal);
    // workflow 也可直接从 App 进入；空闲时采用当前设置，运行中输入留给串行 command 启动时读取。
    await getRuntime().prepareSessionShellEnvironment(
      boundaryOptions?.traceContext ?? traceContext,
      boundaryOptions?.abortSignal,
    );
  };

  return {
    prepareResume,
    prepareUserExecutionBoundary,
    resumeFromStore,
    resolveSessionShellSelection,
  };
}
