import { type LCodePendingPermission } from "@lcode/shared";

import { type PendingPermission } from "@lcode/contracts";

import {
  buildProtocolPermissionOptions,
  toLegacyPermissionOptionsPolicy,
} from "./permission-options.js";

import { asRecord, stringValue } from "./session-mapper-values.js";

export function mapPendingPermission(permission: PendingPermission): LCodePendingPermission {
  // display / optionsPolicy 刻意不进 legacy v3 输出。
  // 根因不是"扩 schema 只能单向兼容"，而是 strict schema 随 packages/shared 打进每个桌面端
  // 的产物：今天把 lcodePendingPermissionSchema（shared/src/lcode-protocol/index.ts:1139）和
  // lcodePermissionRequestedEventPayloadSchema（同文件:1536）改成可选，也保护不了已经装出去
  // 的旧桌面。新 CLI 一旦在 v3 路径上带这两个字段，旧桌面会整份快照解析失败、并用 safeParse
  // 静默丢弃整个 permission.requested 事件——确认窗本身就没了，这违反"只允许预览降级、
  // 不允许 gate 降级"。剥离在源头是唯一对版本偏斜安全的做法；legacy 也没有画因果图的界面。
  // optionsPolicy 的效果仍然生效：它作为 buildProtocolPermissionOptions 的输入裁掉
  // allow_always，只有裁剪后的 options 列表过协议。会话免确认同样降级为裁剪：
  // 旧桌面回传的是 response 原文，认不出会话语义（见 toLegacyPermissionOptionsPolicy）。
  return {
    input: permission.input,
    ...(permission.origin ? { origin: permission.origin } : {}),
    options: buildProtocolPermissionOptions({
      ...permission,
      optionsPolicy: toLegacyPermissionOptionsPolicy(permission.optionsPolicy),
    }),
    reason: permission.reason ?? "",
    requestId: permission.requestId ?? permission.toolCallId,
    requestedAt: permission.requestedAt.getTime(),
    riskLevel: permission.riskLevel,
    toolCallId: permission.toolCallId,
    toolName: permission.toolName,
  };
}

export function mapPermissionRequestedPayload(payload: unknown): Record<string, unknown> {
  // 同 mapPendingPermission：这个 payload 是整体 spread 出去的，新字段必须在这里显式解构
  // 剔除，否则会直接漏进 strict 的 lcodePermissionRequestedEventPayloadSchema。
  const { display: _display, optionsPolicy, ...record } = asRecord(payload);
  const toolName = stringValue(record.toolName) ?? "unknown";
  return {
    ...record,
    options: buildProtocolPermissionOptions({
      input: record.input,
      suggestedPermissionUpdates: Array.isArray(record.suggestedPermissionUpdates)
        ? (record.suggestedPermissionUpdates as PendingPermission["suggestedPermissionUpdates"])
        : undefined,
      optionsPolicy: toLegacyPermissionOptionsPolicy(optionsPolicy),
      toolName,
    }),
  };
}
