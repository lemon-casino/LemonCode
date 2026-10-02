import { ProjectMemoryReviewSourceSchema, type ProjectMemoryReviewSource } from "@lcode/contracts";
import type { ToolExecutionContext } from "../tool/types.js";
import {
  assertReviewCapabilities,
  assertSafeReviewFileName,
  MemoryReviewError,
  reviewSourceCharacterLimit,
  throwIfReviewAborted,
  type FrozenReviewSource,
} from "./review-common.js";
import { readReviewMemoryEvidence } from "./review-memory-evidence.js";
import { memoryReviewProfile } from "./review-profile.js";
import {
  readReviewSessionEvidence,
  validateReviewSessionScope,
} from "./review-session-evidence.js";

/** apply 前读取同一投影，绝不接受工具模型自己声明的“来源仍有效”。不调用模型、不写状态。 */
export async function validateMemoryReviewSources(input: {
  sources: readonly ProjectMemoryReviewSource[];
  context: ToolExecutionContext;
}): Promise<void> {
  await readValidatedMemoryReviewSources(input);
}

/** 独立复核与最终apply共用这一个scope、预算和revision验证路径。 */
export async function readValidatedMemoryReviewSources(input: {
  sources: readonly ProjectMemoryReviewSource[];
  context: ToolExecutionContext;
}): Promise<FrozenReviewSource[]> {
  const context = { ...input.context };
  assertReviewCapabilities(context);
  const profile = memoryReviewProfile(context);
  if (
    !Array.isArray(input.sources) ||
    input.sources.length > profile.sessionLimit + profile.memoryLimit
  ) {
    throw new MemoryReviewError("stale_source");
  }
  const ids = new Set<string>();
  let sessionCount = 0;
  let memoryCount = 0;
  const sources = input.sources.map((source) => {
    const parsed = ProjectMemoryReviewSourceSchema.safeParse(source);
    if (!parsed.success || ids.has(source.id)) throw new MemoryReviewError("stale_source");
    ids.add(source.id);
    const characterLimit = reviewSourceCharacterLimit(parsed.data, context);
    if (source.kind === "session") {
      sessionCount += 1;
      if (
        characterLimit > profile.sessionCharacterLimit ||
        (context.reviewMode === "incremental" &&
          (source.reference !== context.sessionId ||
            source.projection !== "latest-turn" ||
            !source.boundaryMessageId))
      ) {
        throw new MemoryReviewError("stale_source");
      }
    } else {
      memoryCount += 1;
      assertSafeReviewFileName(source.reference, context.memoryRoot!);
    }
    return { source: parsed.data, characterLimit };
  });
  if (sessionCount > profile.sessionLimit || memoryCount > profile.memoryLimit)
    throw new MemoryReviewError("stale_source");
  // 在发出来源读取前先验证全部scope指纹，跨identity/根的提案不能探测另一工作区的文件。
  await validateReviewSessionScope(context);
  let sessionCharacters = 0;
  let memoryCharacters = 0;
  const materials: FrozenReviewSource[] = [];
  for (const { source, characterLimit } of sources) {
    const material =
      source.kind === "session"
        ? await readReviewSessionEvidence(
            source.reference,
            characterLimit,
            context,
            source.boundaryMessageId,
            source.projection,
          )
        : await readReviewMemoryEvidence(source.reference, context);
    if (
      !material ||
      material.source.id !== source.id ||
      material.source.revision !== source.revision
    ) {
      throw new MemoryReviewError("stale_source");
    }
    if (source.kind === "session") sessionCharacters += material.content.length;
    else memoryCharacters += material.content.length;
    if (
      sessionCharacters > profile.sessionTotalCharacterLimit ||
      memoryCharacters > profile.memoryCharacterLimit
    ) {
      throw new MemoryReviewError("stale_source");
    }
    materials.push(material);
  }
  throwIfReviewAborted(context);
  return materials;
}
