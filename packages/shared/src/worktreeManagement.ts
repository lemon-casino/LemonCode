import { z } from "zod";

export const worktreeManagementSettingsSchema = z
  .object({
    autoDeleteEnabled: z.boolean(),
    retainedCount: z.number().int().min(1).max(1000),
    rootLocation: z.enum(["default", "custom", "project"]),
    rootDirectory: z.string().trim().max(4096),
  })
  .strict();
export type WorktreeManagementSettings = z.infer<typeof worktreeManagementSettingsSchema>;
export const DEFAULT_WORKTREE_MANAGEMENT_SETTINGS: WorktreeManagementSettings = {
  autoDeleteEnabled: true,
  retainedCount: 10,
  rootLocation: "default",
  rootDirectory: "",
};
export interface WorktreeCleanupResult {
  archivedIds: string[];
  skipped: { bindingId: string; reason: string }[];
}
