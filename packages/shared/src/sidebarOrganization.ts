import { z } from "zod";

const id = z.string().trim().min(1).max(4096);
export const sidebarWorkspaceRefSchema = z.strictObject({
  workspacePath: z.string().trim().min(1).max(32768),
  workspaceIdentity: z.string().trim().min(1).max(32768).optional(),
});
export const sidebarEntryRefSchema = z.discriminatedUnion("kind", [
  sidebarWorkspaceRefSchema.extend({ kind: z.literal("project"), localProjectId: id.optional() }),
  z.strictObject({ kind: z.literal("worktree"), origin: sidebarWorkspaceRefSchema, bindingId: id }),
  z.strictObject({ kind: z.literal("task"), workspace: sidebarWorkspaceRefSchema, taskId: id }),
  z.strictObject({ kind: z.literal("executionSet"), origin: sidebarWorkspaceRefSchema, executionSetId: id, projectId: id }),
]);
export type SidebarEntryRef = z.infer<typeof sidebarEntryRefSchema>;
export const sidebarSectionSchema = z.strictObject({
  id,
  title: z.string().trim().min(1).max(80),
  entries: z.array(sidebarEntryRefSchema).max(10000),
  defaultTargetRef: sidebarEntryRefSchema.optional(),
});
export type SidebarSection = z.infer<typeof sidebarSectionSchema>;
export const sidebarOrganizationSchema = z.strictObject({
  version: z.union([z.literal(1), z.literal(2)]),
  revision: z.number().int().nonnegative(),
  sections: z.array(sidebarSectionSchema).max(500),
  rootOrders: z.array(sidebarEntryRefSchema).max(10000).default([]),
  importedSources: z.array(id),
});
export type SidebarOrganization = z.infer<typeof sidebarOrganizationSchema>;
export const sidebarMutationSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("editSection"),
    sectionId: id,
    title: z.string().trim().min(1).max(80),
    entries: z.array(sidebarEntryRefSchema).max(10000),
    defaultTargetRef: sidebarEntryRefSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("forget"),
    entries: z.array(sidebarEntryRefSchema).min(1).max(10000),
  }),
  z.strictObject({
    type: z.literal("create"),
    section: sidebarSectionSchema,
    index: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    type: z.literal("rename"),
    sectionId: id,
    title: z.string().trim().min(1).max(80),
  }),
  z.strictObject({ type: z.literal("remove"), sectionId: id }),
  z.strictObject({
    type: z.literal("move"),
    entries: z.array(sidebarEntryRefSchema).min(1).max(10000),
    sectionId: id.nullable(),
    index: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    type: z.literal("reorder"),
    sectionId: id,
    index: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal("reorderRoot"),
    kind: z.enum(["project", "worktree", "task", "executionSet"]),
    entries: z.array(sidebarEntryRefSchema).max(10000),
  }),
  z.strictObject({
    type: z.literal("import"),
    source: id,
    sections: z.array(sidebarSectionSchema).max(500),
  }),
]);
export type SidebarMutation = z.infer<typeof sidebarMutationSchema>;
export const sidebarOrganizationRequestSchema = z.strictObject({
  operationId: id,
  expectedRevision: z.number().int().nonnegative(),
  mutations: z.array(sidebarMutationSchema).min(1).max(1000),
});
export type SidebarOrganizationRequest = z.infer<typeof sidebarOrganizationRequestSchema>;
export const sidebarOrganizationResultSchema = z.strictObject({
  status: z.enum(["applied", "conflict"]),
  snapshot: sidebarOrganizationSchema,
});
export type SidebarOrganizationResult = z.infer<typeof sidebarOrganizationResultSchema>;

export function sidebarEntryKey(entry: SidebarEntryRef): string {
  const scope =
    entry.kind === "task" ? entry.workspace : entry.kind === "project" ? entry : entry.origin;
  return JSON.stringify([
    entry.kind,
    scope.workspaceIdentity?.trim() || scope.workspacePath,
    entry.kind === "task" ? entry.taskId : entry.kind === "worktree" ? entry.bindingId : entry.kind === "executionSet" ? entry.executionSetId : "",
  ]);
}
export function emptySidebarOrganization(): SidebarOrganization {
  return { version: 1, revision: 0, sections: [], rootOrders: [], importedSources: [] };
}
