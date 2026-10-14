import { z } from "zod";

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
