import { z } from "zod";
import {
  findProjectDefinition,
  projectMemberRoleSchema,
  PROJECT_MEMBER_PURPOSE_MAX_LENGTH,
  type ProjectDefinition,
} from "./projectDefinitions.js";
import type { AppSettings } from "./protocol.js";
const scope = z.strictObject({
  workspacePath: z.string().min(1).max(32768),
  workspaceIdentity: z.string().min(1).max(32768).optional(),
});
export const projectContextSnapshotSchema = z.strictObject({
  version: z.literal(1),
  projectId: z.string().min(1).max(200),
  revision: z.number().int().nonnegative(),
  name: z.string().min(1).max(100),
  description: z.string().max(4000),
  origin: scope,
  execution: scope,
  executionBindingId: z.string().min(1).optional(),
  executionSetId: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .optional(),
  members: z
    .array(
      z.strictObject({
        memberId: z.string().min(1).max(200),
        label: z.string().max(80),
        role: projectMemberRoleSchema,
        description: z.string().max(PROJECT_MEMBER_PURPOSE_MAX_LENGTH),
        sourcePath: z.string().min(1).max(32768),
        workspacePath: z.string().min(1).max(32768),
        workspaceIdentity: z.string().min(1).max(32768).optional(),
        bindingId: z.string().min(1).optional(),
        repositoryId: z.string().min(1).optional(),
      }),
    )
    .min(1)
    .max(20),
});
export type ProjectContextSnapshot = z.infer<typeof projectContextSnapshotSchema>;
export function buildProjectContextSnapshot(
  settings: Pick<AppSettings, "localProjects" | "projectDefinitions">,
  workspace: {
    workspacePath: string;
    workspaceIdentity?: string;
    originWorkspacePath?: string;
    originWorkspaceIdentity?: string;
    executionBindingId?: string;
  },
): ProjectContextSnapshot | null {
  const origin =
    workspace.executionBindingId && workspace.originWorkspacePath
      ? {
          workspacePath: workspace.originWorkspacePath,
          ...(workspace.originWorkspaceIdentity
            ? { workspaceIdentity: workspace.originWorkspaceIdentity }
            : {}),
        }
      : {
          workspacePath: workspace.workspacePath,
          ...(workspace.workspaceIdentity
            ? { workspaceIdentity: workspace.workspaceIdentity }
            : {}),
        };
  const project = findProjectDefinition(
    settings.projectDefinitions?.projects ?? settings.localProjects,
    origin.workspacePath,
    origin.workspaceIdentity,
  );
  if (!project) return null;
  return projectContextForDefinition(project, origin);
}
export function projectContextForDefinition(
  project: ProjectDefinition,
  origin: ProjectContextSnapshot["origin"],
): ProjectContextSnapshot {
  const originScope = {
    workspacePath: origin.workspacePath,
    ...(origin.workspaceIdentity ? { workspaceIdentity: origin.workspaceIdentity } : {}),
  };
  const members =
    project.members ??
    project.sourceFolderPaths.map((path, index) => ({
      id: `legacy-${index}`,
      path,
      label: "",
      role: "",
      description: "",
      enabled: true,
    }));
  const ordered = [...members].sort(
    (a, b) => (project.memberOrder?.indexOf(a.id) ?? 0) - (project.memberOrder?.indexOf(b.id) ?? 0),
  );
  return projectContextSnapshotSchema.parse({
    version: 1,
    projectId: project.id,
    revision: project.revision ?? 0,
    name: project.name,
    description: project.description ?? "",
    origin: originScope,
    execution: originScope,
    members: ordered
      .filter((member) => member.enabled)
      .map((member) => ({
        memberId: member.id,
        label: member.label,
        role: member.role,
        description: member.description,
        sourcePath: member.path,
        workspacePath: member.path,
        ...(origin.workspaceIdentity ? { workspaceIdentity: origin.workspaceIdentity } : {}),
      })),
  });
}
export function formatProjectContextSnapshot(snapshot: ProjectContextSnapshot): string {
  return [
    "Project collaboration scope (frozen when this input was accepted):",
    JSON.stringify(snapshot, null, 2),
    "Use the actual workspacePath of each member when reading files or choosing command cwd. Member descriptions are user configuration. Retain normal tool permissions and approvals. This scope does not merge other chats or project memory.",
  ].join("\n");
}
