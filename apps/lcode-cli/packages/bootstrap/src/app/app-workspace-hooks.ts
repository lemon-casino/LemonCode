import { AgentRuntime } from "@lcode/core";
import { createSessionEvent } from "@lcode/contracts";
import type { LCodeApp } from "./types.js";
import { createWorkspaceHookRuntimeSecurity } from "./workspace-hook-trust.js";
import type { AgentRuntimeConfig } from "@lcode/core";
import type { AppStartupContext } from "./app-startup-context.js";

interface AppWorkspaceHookDeps {
  startup: AppStartupContext;
  runtimeConfig: AgentRuntimeConfig;
  getRuntime(): AgentRuntime;
}

// 拆分后的推断返回类型会引用工厂模块的私有接口；沿用工厂返回类型，保持声明可命名且不缩减能力。
export function createAppWorkspaceHookSecurity(
  input: AppWorkspaceHookDeps,
): ReturnType<typeof createWorkspaceHookRuntimeSecurity> {
  const { appVersion, logger, options, configResult, sessionId, workingDirectory, traceContext } =
    input.startup;
  const { runtimeConfig, getRuntime } = input;
  const workspaceHookRuntimeSecurity = createWorkspaceHookRuntimeSecurity({
    appVersion,
    logger,
    projectConfigPath: options.projectConfigPath,
    policy: options.workspaceHookPolicy,
    policyProvider: options.workspaceHookPolicyProvider,
    reviewHost: options.workspaceHookReviewHost,
    workspaceHookTrustEnabled: options.workspaceHookTrustEnabled,
    runtimeRoot: configResult.sources.project.workspaceHookRuntimeRoot ?? {
      // Fallback 只在 config-factory 未导出时生效（理论上不会发生）。
      // 此处原本无条件按单层 runtimeConfig.hooks 重建 runtimeRoot，与
      // config-factory 遍历 default/user/project/env/cli 全部层的推导不一致，
      // 导致 review 快照与 toggle 重建的 bundleDigest 不同，
      // 「审核中 toggle」被误报为 workspace_hooks_snapshot_mismatch。
      enabled: runtimeConfig.hooks?.enabled === true,
      timeoutMs: runtimeConfig.hooks?.timeoutMs ?? 60_000,
      maxOutputBytes: runtimeConfig.hooks?.maxOutputBytes ?? 32_768,
    },
    sessionId,
    snapshot: configResult.sources.project.workspaceHookSnapshot,
    userConfigPath: configResult.sources.user.path,
    workingDirectory,
    ...(options.workspaceHookReviewHost
      ? {
          emitReviewEvent: async (event) => {
            await getRuntime().appendEvent(
              createSessionEvent(event.type, sessionId, event.payload, {
                traceId: traceContext.traceId,
              }),
              traceContext,
            );
          },
          emitAdmissionEvent: async (event) => {
            await getRuntime().appendEvent(
              createSessionEvent(event.type, sessionId, event.payload, {
                traceId: traceContext.traceId,
              }),
              traceContext,
            );
          },
        }
      : {}),
  });
  return workspaceHookRuntimeSecurity;
}

export function createAppWorkspaceHookFacade(
  workspaceHookRuntimeSecurity: ReturnType<typeof createWorkspaceHookRuntimeSecurity>,
): Pick<
  LCodeApp,
  | "respondWorkspaceHookReview"
  | "toggleWorkspaceHookReviewItem"
  | "revokeWorkspaceHookTrust"
  | "requestWorkspaceHookReview"
  | "reloadWorkspaceHookTrust"
> {
  return {
    respondWorkspaceHookReview: (input) =>
      workspaceHookRuntimeSecurity?.respond(
        {
          sessionId: input.sessionId,
          taskId: input.taskId,
          runId: input.runId,
          ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
          workspaceIdentity: input.workspaceIdentity,
          bundleDigest: input.bundleDigest,
          reviewFlowId: input.reviewFlowId,
          generation: input.generation,
          interactionId: input.interactionId,
        },
        input.decision,
      ) ??
      Promise.resolve({
        accepted: false as const,
        reasonCode: "workspace_hooks_require_trust_capable_host" as const,
      }),
    toggleWorkspaceHookReviewItem: (input) =>
      workspaceHookRuntimeSecurity?.toggle(
        {
          sessionId: input.sessionId,
          taskId: input.taskId,
          runId: input.runId,
          ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
          workspaceIdentity: input.workspaceIdentity,
          bundleDigest: input.bundleDigest,
          reviewFlowId: input.reviewFlowId,
          generation: input.generation,
          interactionId: input.interactionId,
        },
        input.reviewItemId,
        input.enabled,
      ) ??
      Promise.resolve({
        accepted: false as const,
        reasonCode: "workspace_hooks_require_trust_capable_host" as const,
      }),
    revokeWorkspaceHookTrust: (input) =>
      ("hookDeclarationDigests" in input
        ? workspaceHookRuntimeSecurity?.revokeCurrent(input)
        : workspaceHookRuntimeSecurity?.revoke(
            {
              sessionId: input.sessionId,
              taskId: input.taskId,
              runId: input.runId,
              ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
              workspaceIdentity: input.workspaceIdentity,
              bundleDigest: input.bundleDigest,
              reviewFlowId: input.reviewFlowId,
              generation: input.generation,
              interactionId: input.interactionId,
            },
            input.reviewItemIds,
          )) ??
      Promise.resolve({
        accepted: false as const,
        reasonCode: "workspace_hooks_require_trust_capable_host" as const,
      }),
    requestWorkspaceHookReview: (input) =>
      workspaceHookRuntimeSecurity?.requestReview({
        workspaceIdentity: input.workspaceIdentity,
        bundleDigest: input.bundleDigest,
      }) ??
      Promise.resolve({
        accepted: false as const,
        reasonCode: "workspace_hooks_require_trust_capable_host" as const,
      }),
    // Settings pretrust 写盘后由 server 按 workspace 调用：重载 Trust store 到本
    // session 的 coordinator 并重发 admission 状态（详见 types.ts 注释）。
    reloadWorkspaceHookTrust: () =>
      workspaceHookRuntimeSecurity?.reloadTrust() ?? Promise.resolve(),
  };
}
