import { createHash } from "node:crypto";
import type { Logger, WorkspaceHookReasonCode } from "@lcode/contracts";

export type WorkspaceHookTelemetryEvent =
  | "workspace_hook.feature_disabled"
  | "workspace_hook.review_request_created"
  | "workspace_hook.trust_selected"
  | "workspace_hook.review_timeout"
  | "workspace_hook.review_superseded"
  | "workspace_hook.snapshot_mismatch"
  | "workspace_hook.policy_blocked"
  | "workspace_hook.trust_store_failure"
  | "workspace_hook.toggle_failure"
  | "workspace_hook.config_rebuild_failure"
  // revoke 需要专门观测：排查「撤销后面板失效」时，必须能从日志判断
  // 撤销是否成功、并区分随后的失败属于撤销还是授权，否则定位缓慢。
  | "workspace_hook.revoked"
  | "workspace_hook.stale_response";

export interface WorkspaceHookTelemetryFields {
  workspaceIdentity?: string;
  bundleDigest?: string;
  declarationDigest?: string;
  reasonCode?: WorkspaceHookReasonCode;
  source?: string;
  action?: string;
  generation?: number;
  /**
   * 调用侧传入的 errorMessage 需要透传：否则原始错误在 emit 时被静默丢弃，
   * 日志里只剩 reasonCode，实际排查无法定位真实 cause。
   * 仅承载领域错误自身的短消息，不携带命令、脚本内容或 Trust payload。
   */
  errorMessage?: string;
  /**
   * Trust 落盘条数诊断：store 写入少于已选择声明时，decisionAccepted
   * 未抛错），日志无从判断是 request 少带了 item 还是写入阶段丢了记录。
   *
   * requestItemCount / requestEnabledCount 记录审核请求实际携带的条数；
   * grantedRecordCount 记录本次真正写入的条数。三者对不上即为静默丢失。
   */
  requestItemCount?: number;
  requestEnabledCount?: number;
  grantedRecordCount?: number;
  /** revoke 实际撤销的声明条数（与 grantedRecordCount 分开，避免语义混用）。 */
  revokedCount?: number;
}

const MAX_TELEMETRY_ERROR_MESSAGE_LENGTH = 300;

/**
 * Workspace Hook 的观测统一复用现有 Logger Port。
 * 只发送稳定 reason、generation 和摘要，不发送命令、脚本内容、路径或 Trust payload。
 */
export function emitWorkspaceHookTelemetry(
  logger: Logger | undefined,
  event: WorkspaceHookTelemetryEvent,
  fields: WorkspaceHookTelemetryFields = {},
): void {
  if (!logger) return;
  logger.info("Workspace Hook Trust telemetry", {
    event,
    module: "workspace_hook_trust",
    ...(fields.workspaceIdentity
      ? { workspaceIdentityDigest: workspaceIdentitySummary(fields.workspaceIdentity) }
      : {}),
    ...(fields.bundleDigest ? { bundleDigest: digestSummary(fields.bundleDigest) } : {}),
    ...(fields.declarationDigest
      ? { declarationDigest: digestSummary(fields.declarationDigest) }
      : {}),
    ...(fields.reasonCode ? { reasonCode: fields.reasonCode } : {}),
    ...(fields.source ? { source: fields.source } : {}),
    ...(fields.action ? { action: fields.action } : {}),
    ...(fields.generation === undefined ? {} : { generation: fields.generation }),
    ...(fields.errorMessage
      ? { errorMessage: fields.errorMessage.slice(0, MAX_TELEMETRY_ERROR_MESSAGE_LENGTH) }
      : {}),
    ...(fields.requestItemCount === undefined ? {} : { requestItemCount: fields.requestItemCount }),
    ...(fields.requestEnabledCount === undefined
      ? {}
      : { requestEnabledCount: fields.requestEnabledCount }),
    ...(fields.grantedRecordCount === undefined
      ? {}
      : { grantedRecordCount: fields.grantedRecordCount }),
    ...(fields.revokedCount === undefined ? {} : { revokedCount: fields.revokedCount }),
  });
}

export function digestSummary(value: string): string {
  return value.length <= 12 ? value : value.slice(0, 12);
}

/**
 * workspace identity 的 SHA-256 短摘要。
 *
 * 本实现的 identity 就是绝对路径，明文要求 telemetry 不上传
 * 完整 workspace path、不记录 source path，因此任何要进入 telemetry 的文本
 * （含领域错误的 message）都必须先经此脱敏，而不是依赖下游过滤。
 */
export function workspaceIdentitySummary(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
