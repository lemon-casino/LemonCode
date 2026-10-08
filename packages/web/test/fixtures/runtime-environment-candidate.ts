import type { WorktreeIntegration } from "@lcode/services";
import { worktreeCandidateEvidenceSchema, worktreeValidationReceiptSchema } from "@lcode/shared";
import { environmentBinding, origin } from "./runtime-environment-service.js";

export function createRuntimeCandidateFixture(calls: { method: string; params: unknown }[]) {
  let operation: WorktreeIntegration = {
    id: "candidate-operation",
    requestId: "candidate-request",
    bindingId: environmentBinding.id,
    sourceHead: "source",
    targetHead: "target",
    targetBranch: "main",
    targetPath: origin,
    checkoutPath: `${origin}/候选`,
    candidateHead: "candidate-head",
    status: "awaiting-review",
    conflictPaths: [],
    validationCommands: [],
    validationResults: [],
    environmentPolicy: "local",
    createdAt: "now",
    updatedAt: "now",
  };
  const binding = { ...environmentBinding, latestIntegrationId: operation.id };
  const controller = {
    operation: () => structuredClone(operation),
    breakDigest: () => {
      operation = {
        ...operation,
        candidateEvidence: operation.candidateEvidence
          ? { ...operation.candidateEvidence, candidateHead: "stale-head" }
          : undefined,
      };
    },
  };
  const service = {
    getBinding: async () => structuredClone(binding),
    getIntegration: async () => structuredClone(operation),
    getCapabilities: async () => ({
      supported: true,
      integrate: true,
      create: true,
      restore: true,
      archive: true,
      head: "source",
    }),
    continueIntegration: async (params: {
      operationId: string;
      approvedCandidateHead?: string;
      skipValidation?: boolean;
      cancel?: boolean;
    }) => {
      calls.push({ method: "continueIntegration", params });
      if (params.cancel) return (operation = { ...operation, status: "cancelled" });
      if (params.skipValidation !== true) throw new Error("fixture explicit skip required");
      const receipt = worktreeValidationReceiptSchema.parse({
        candidateHead: "candidate-head",
        candidateTree: "tree",
        sourceHead: "source",
        targetHead: "target",
        targetBranch: "main",
        environmentPolicy: "local",
        command: null,
        outcome: "skipped",
        exitCode: null,
        output: "",
        skipAcknowledged: true,
        verifiedAt: "now",
      });
      const evidence = worktreeCandidateEvidenceSchema.parse({
        candidateHead: "candidate-head",
        candidateTree: "tree",
        sourceHead: "source",
        targetHead: "target",
        targetBranch: "main",
        environmentPolicy: "local",
        validationCommands: [],
        validationReceipts: [receipt],
        validatedAt: "now",
      });
      operation = {
        ...operation,
        status: "ready",
        validationReceipts: [receipt],
        candidateEvidence: evidence,
      };
      return structuredClone(operation);
    },
    publishIntegration: async (params: { skipValidation?: boolean }) => {
      calls.push({ method: "publishIntegration", params });
      if (params.skipValidation !== true) throw new Error("fixture publish requires explicit skip");
      // 此 fixture 验证请求参数与收据门禁，不执行 Git，也不把 fixture receipt 当成生产 owner 证明。
      return structuredClone(operation);
    },
  };
  return { service, controller };
}
