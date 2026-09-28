import { resolve } from "node:path";
import { workspaceHookPolicySchema } from "@lcode/contracts";
import type { WorkspaceHookPolicyProvider } from "@lcode/core";
import {
  lcodeWorkspaceHookTrustGrantParamsSchema,
  lcodeWorkspaceHookTrustGrantReasonCodeSchema,
  lcodeWorkspaceHookTrustGrantResultSchema,
  type LCodeWorkspaceHookTrustGrantReasonCode,
  type LCodeWorkspaceHookTrustGrantResult,
} from "@lcode/shared";
import {
  grantWorkspaceHookTrust,
  type WorkspaceHookTrustCliStatus,
} from "../workspace-hook-trust-cli.js";

type GrantWorkspaceHookTrust = typeof grantWorkspaceHookTrust;

/**
 * 没有 task/session 时的 workspace 级 Trust authority。
 *
 * 可信 Host 只能提交 Settings 看到的精确 bundle/declaration；真正授权前仍由 Agent
 * 重新发现 canonical snapshot。这里不创建隐藏 task，也不接受 UI 直接提供的记录内容。
 */
export async function grantWorkspaceHookTrustForProtocol(
  rawParams: unknown,
  dependencies: {
    appVersion?: string;
    grant?: GrantWorkspaceHookTrust;
    policyProvider: WorkspaceHookPolicyProvider;
  },
): Promise<LCodeWorkspaceHookTrustGrantResult> {
  const params = lcodeWorkspaceHookTrustGrantParamsSchema.parse(rawParams);
  const grant = dependencies.grant ?? grantWorkspaceHookTrust;
  const workspaceIdentity =
    params.workspace.workspaceIdentity?.trim() || resolve(params.workspace.workspacePath);
  const policyRejection = getPolicyRejectionReason(
    dependencies.policyProvider,
    workspaceIdentity,
  );
  if (policyRejection) {
    return lcodeWorkspaceHookTrustGrantResultSchema.parse({
      accepted: false,
      reasonCode: policyRejection,
    });
  }
  try {
    const status = await grant({
      workspacePath: params.workspace.workspacePath,
      ...(params.workspace.workspaceIdentity
        ? { workspaceIdentity: params.workspace.workspaceIdentity }
        : {}),
      bundleDigest: params.bundleDigest,
      hookDeclarationDigests: [params.hookDeclarationDigest],
      ...(dependencies.appVersion ? { appVersion: dependencies.appVersion } : {}),
    });
    return lcodeWorkspaceHookTrustGrantResultSchema.parse(
      didGrantExactDeclaration(status, params.hookDeclarationDigest)
        ? { accepted: true }
        : { accepted: false, reasonCode: toPublicReasonCode(status.reasonCode) },
    );
  } catch (error) {
    return lcodeWorkspaceHookTrustGrantResultSchema.parse({
      accepted: false,
      reasonCode: toPublicReasonCode(error),
    });
  }
}

function getPolicyRejectionReason(
  policyProvider: WorkspaceHookPolicyProvider,
  workspaceIdentity: string,
): LCodeWorkspaceHookTrustGrantReasonCode | undefined {
  try {
    const policy = workspaceHookPolicySchema.parse(
      policyProvider.getPolicy(workspaceIdentity),
    );
    if (policy.mode === "user_decides") return undefined;
    return policy.mode === "allow_trusted_only"
      ? "workspace_hooks_policy_requires_pretrust"
      : "workspace_hooks_blocked_by_policy";
  } catch {
    // Settings 无 session 路径曾在重新发现后直接写 Trust store，绕过受信
    // embedder policy。policy provider 异常时也必须 fail closed，不能退回默认可授权。
    return "workspace_hooks_blocked_by_policy";
  }
}

function toPublicReasonCode(error: unknown): LCodeWorkspaceHookTrustGrantReasonCode {
  const candidate = error instanceof Error ? error.message : error;
  const parsed = lcodeWorkspaceHookTrustGrantReasonCodeSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;

  // 这里曾把底层 Error.message 直接放进 reasonCode，导致配置绝对路径和
  // 用户名越过 Agent/Host/UI 协议边界。未知异常只能收敛到公开稳定码，不能透传文本。
  return "workspace_hooks_config_unreadable";
}

function didGrantExactDeclaration(
  status: WorkspaceHookTrustCliStatus,
  hookDeclarationDigest: string,
): boolean {
  return status.items.some(
    (item) =>
      item.hookDeclarationDigest === hookDeclarationDigest &&
      item.trustState === "trusted_persistent",
  );
}
