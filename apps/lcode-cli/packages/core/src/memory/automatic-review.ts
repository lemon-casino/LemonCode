import { createHash } from "node:crypto";
import {
  isFileSystemPortError,
  ProjectMemoryReviewDraftSchema,
  ProjectMemoryReviewItemSchema,
  ProjectMemoryVerificationSchema,
  type ProjectMemoryReview,
  type ProjectMemoryReviewDraft,
} from "@lcode/contracts";
import type { ToolExecutionContext } from "../tool/types.js";
import { generateMemoryReviewDraft } from "./review-generation.js";
import { MemoryReviewError, throwIfReviewAborted } from "./review-common.js";
import { readValidatedMemoryReviewSources } from "./review-validation.js";
import { verifyMemoryReviewDraft } from "./review-verification.js";

export interface AutomaticMemoryReviewResult {
  status: "completed" | "no-change";
  proposalId?: string;
  appliedCount: number;
  rejectedCount: number;
  conflictCount: number;
  skippedReason?: "history-full" | "reviews-full" | "preimages-full" | "recovery-required";
}

export async function runAutomaticMemoryReview(input: {
  query: string;
  context: ToolExecutionContext;
}): Promise<AutomaticMemoryReviewResult> {
  const context = { ...input.context };
  const port = context.fileSystemPort?.projectMemory;
  const rootDir = context.memoryRoot;
  if (!port || !rootDir) throw new MemoryReviewError("unavailable");
  throwIfReviewAborted(context);
  const capacity = await port.inspectCapacity(rootDir, {
    signal: context.abortSignal,
    trace: context.traceContext,
  });
  if (!capacity.available) {
    return {
      status: "no-change",
      appliedCount: 0,
      rejectedCount: 0,
      conflictCount: 0,
      ...(capacity.reason ? { skippedReason: capacity.reason } : {}),
    };
  }
  const draft = ProjectMemoryReviewDraftSchema.parse(await generateMemoryReviewDraft(input));
  if (draft.items.length === 0) {
    return { status: "no-change", appliedCount: 0, rejectedCount: 0, conflictCount: 0 };
  }

  // 第二次请求只有冻结候选和实际来源，不继承生成者的对话/推理；模型没有写端口。
  const verification = ProjectMemoryVerificationSchema.parse(
    await verifyMemoryReviewDraft({ draft, context }),
  );
  const ids = new Set(draft.items.map((item) => item.id));
  const accepted = new Set(verification.acceptedItemIds);
  if (
    accepted.size !== verification.acceptedItemIds.length ||
    verification.acceptedItemIds.some((id) => !ids.has(id)) ||
    verification.reasons.length !== ids.size ||
    new Set(verification.reasons.map((decision) => decision.itemId)).size !== ids.size ||
    verification.reasons.some((decision) => !ids.has(decision.itemId))
  ) {
    throw new MemoryReviewError("invalid_response");
  }
  throwIfReviewAborted(context);
  const options = { signal: context.abortSignal, trace: context.traceContext };
  // 生成者summary未经过逐项核验，不能作为持久事实或list诊断再次传播。
  const storedDraft = {
    ...draft,
    summary: `Reviewed ${draft.items.length} candidates; accepted ${accepted.size}.`,
  };
  const proposal = await port.saveReview({ rootDir, draft: storedDraft, verification }, options);
  assertStoredDraftMatches(proposal, storedDraft);
  let appliedCount = 0;
  let conflictCount = 0;
  for (const item of draft.items) {
    if (!accepted.has(item.id)) continue;
    throwIfReviewAborted(context);
    try {
      if (Object.hasOwn(proposal.appliedItems, item.id)) continue;
      const evidence = await readValidatedMemoryReviewSources({
        sources: draft.sources.filter((source) => item.sourceIds.includes(source.id)),
        context,
      });
      const expectedSourceHashes = evidence
        .filter((material) => material.source.kind === "memory")
        .map((material) => {
          if (!material.expectedHash) throw new MemoryReviewError("stale_source");
          return { fileName: material.source.reference, hash: material.expectedHash };
        });
      const expectedItemHash = `sha256:${createHash("sha256")
        .update(JSON.stringify(ProjectMemoryReviewItemSchema.parse(item)))
        .digest("hex")}`;
      await port.applyReview(
        {
          rootDir,
          proposalId: proposal.id,
          revision: proposal.revision,
          itemId: item.id,
          expectedItemHash,
          expectedSourceHashes,
        },
        options,
      );
      appliedCount += 1;
    } catch (error) {
      throwIfReviewAborted(context);
      if (
        (isFileSystemPortError(error) && error.code === "stale_write") ||
        (error instanceof MemoryReviewError && error.code === "stale_source")
      ) {
        // 前景编辑优先，旧证据不能覆盖新正文；仅后续新快照可重新形成候选。
        conflictCount += 1;
        continue;
      }
      throw error;
    }
  }
  return {
    status: "completed",
    proposalId: proposal.id,
    appliedCount,
    rejectedCount: draft.items.length - accepted.size,
    conflictCount,
  };
}

function assertStoredDraftMatches(
  proposal: ProjectMemoryReview,
  draft: ProjectMemoryReviewDraft,
): void {
  if (
    JSON.stringify(ProjectMemoryReviewDraftSchema.parse(proposal.draft)) !== JSON.stringify(draft)
  ) {
    throw new MemoryReviewError("stale_source");
  }
}
