import type { WorktreeBinding } from "@lcode/services";

export function createWorktreeLifecycleFixture(
  calls: { method: string; params: unknown }[],
  binding: WorktreeBinding,
  config: () => { failArchive: boolean; ignoredCount: number },
) {
  return {
    getIntegrationPreflight: async ({ targetBranch }: { targetBranch: string }) => ({
      bindingId: binding.id,
      targetBranch,
      sourceHead: "s".repeat(40),
      targetHead: "t".repeat(40),
      sourceCommitCount: 1,
      uncommittedFileCount: 0,
      alreadyContained: false,
    }),
    archive: async (params: {
      acknowledgeIgnoredFiles?: boolean;
      discard?: { branch: string; checkoutPath: string };
    }) => {
      calls.push({ method: "archive", params });
      if (config().failArchive) throw new Error("fixture-archive-failed");
      if (params.discard) {
        binding.status = "deleted";
        binding.snapshot = undefined;
        return structuredClone(binding);
      }
      if (!params.acknowledgeIgnoredFiles)
        throw new Error("Ignored files require explicit acknowledgement");
      binding.status = "archived";
      binding.snapshot = {
        commit: "snapshot",
        indexTree: "index",
        head: "base",
        createdAt: "2026-01-01",
        ignoredPaths: Array.from({ length: config().ignoredCount }, (_, i) => `ignored-${i}.env`),
      };
      return structuredClone(binding);
    },
    restore: async (params: unknown) => {
      calls.push({ method: "restore", params });
      binding.status = "ready";
      return structuredClone(binding);
    },
  };
}
