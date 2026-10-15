import { z } from "zod";
import { isRemoteWorkspaceIdentity } from "./remote-workspace-identity.js";

// 目录只暴露 endpoint 的展示身份，不透出认证字段或凭据存储 key。
const catalogTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ssh"),
      host: z.string().min(1),
      username: z.string().min(1),
      port: z.number().int().positive().optional(),
      sshConfigAlias: z.string().optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal("wsl"), distro: z.string().optional(), user: z.string().optional() })
    .strict(),
  z.object({ kind: z.literal("docker"), container: z.string().min(1) }).strict(),
]);
const remoteScopeSchema = z
  .object({
    kind: z.literal("remote"),
    remoteSessionId: z.string().trim().min(1),
    workspacePath: z.string().min(1),
    workspaceIdentity: z.string().trim().min(1),
    generation: z.number().int().positive(),
  })
  .strict();
export const windowWorkspaceScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local") }).strict(),
  remoteScopeSchema,
]);
export type WindowWorkspaceScope = z.infer<typeof windowWorkspaceScopeSchema>;
export const windowWorkspaceCatalogEntrySchema = z
  .object({
    scope: remoteScopeSchema,
    target: catalogTargetSchema,
    sourceAvailability: z.enum(["online", "offline"]),
  })
  .strict();
export const windowWorkspaceCatalogSchema = z.array(windowWorkspaceCatalogEntrySchema);
export type WindowWorkspaceCatalogEntry = z.infer<typeof windowWorkspaceCatalogEntrySchema>;
export const windowWorkspaceRpcCallSchema = z
  .object({
    scope: windowWorkspaceScopeSchema,
    channel: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.unknown()).optional(),
  })
  .strict();
export type WindowWorkspaceRpcCall = z.infer<typeof windowWorkspaceRpcCallSchema>;
export const windowWorkspaceRpcListenSchema = z
  .object({
    scope: windowWorkspaceScopeSchema,
    channel: z.string().min(1),
    event: z.string().min(1),
    arg: z.unknown().optional(),
  })
  .strict();
export type WindowWorkspaceRpcListen = z.infer<typeof windowWorkspaceRpcListenSchema>;

// 重连只接受已有项目身份，连接参数与凭据始终由 Desktop owner 提供。
export const windowWorkspaceReconnectTargetSchema = z
  .object({
    workspacePath: z.string().min(1),
    workspaceIdentity: z.string().trim().refine(isRemoteWorkspaceIdentity),
  })
  .strict();
export type WindowWorkspaceReconnectTarget = z.infer<typeof windowWorkspaceReconnectTargetSchema>;
export const windowWorkspaceReconnectRequestSchema = windowWorkspaceReconnectTargetSchema.extend({
  requestId: z.string().min(1),
});
export type WindowWorkspaceReconnectRequest = z.infer<typeof windowWorkspaceReconnectRequestSchema>;
export const windowWorkspaceReconnectResultSchema = z.discriminatedUnion("ok", [
  z.object({ requestId: z.string().min(1), ok: z.literal(true) }).strict(),
  z
    .object({ requestId: z.string().min(1), ok: z.literal(false), error: z.string().min(1) })
    .strict(),
]);
export type WindowWorkspaceReconnectResult = z.infer<typeof windowWorkspaceReconnectResultSchema>;
export const WINDOW_WORKSPACE_RECONNECT_UNAVAILABLE = "WINDOW_WORKSPACE_RECONNECT_UNAVAILABLE";
export const WINDOW_WORKSPACE_RECONNECT_TARGET_UNAVAILABLE =
  "WINDOW_WORKSPACE_RECONNECT_TARGET_UNAVAILABLE";
