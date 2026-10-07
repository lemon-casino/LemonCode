import { acquireFileLock } from "@lcode/shared/node";
import type { ResourceCollectionParams, ResourceCollectionResult } from "../app/resourceControl.js";
import {
  inspectResourcePath, removeResourceTree, ResourceBudget, resourceFailure, ResourceScanFailure,
  summarizeResources, type ResourceTreeEntry,
} from "./resourceFilesystem.js";
import { openResourceJournal } from "./resourceJournal.js";
import { scanResourceReferences } from "./resourceReferences.js";
import { isProtectedTool, scanManagedTools, validateProtectedTools, type ManagedResourceCandidate } from "./resourceTools.js";

function block(result: ResourceCollectionResult, failure: ResourceScanFailure): void {
  result.status = failure.status === "partial" || result.deletedEntries > 0 ? "partial" : "blocked";
  result.summary.status = failure.status;
  result.summary.reason = failure.message;
  result.error = { code: "gc-incomplete", stage: "collectingGarbage", message: failure.message, retryable: true };
}
function publicCandidates(candidates: ManagedResourceCandidate[]) {
  return candidates.map(({ path, kind, state }) => ({ path, kind, state }));
}

/** GC → journal 独占 → 全量引用/候选验证 → 安装锁 → 再扫引用 → 写意图 → 逐项删除 → 结算。 */
export async function collectResources(root: string, input: ResourceCollectionParams): Promise<ResourceCollectionResult> {
  const budget = new ResourceBudget(input.budget);
  const params = { ...input, budget: budget.limits };
  const result: ResourceCollectionResult = { operationId: params.operationId, status: "succeeded", deletedEntries: 0,
    protectedEntries: 0, summary: summarizeResources(budget, []), candidates: [] };
  let journal: Awaited<ReturnType<typeof openResourceJournal>> | undefined;
  let candidates: ManagedResourceCandidate[] = [];
  const entries: ResourceTreeEntry[] = [];
  try {
    journal = await openResourceJournal(root, params, budget);
    if (journal.previous?.settled) return journal.previous.result;
    if (journal.previous) {
      const previous = journal.previous.result;
      // 崩溃窗口无法证明删除次数/目录代际；同请求不重放破坏性步骤，新请求须重新证明全量引用。
      block(previous, new ResourceScanFailure("unavailable", "GC was interrupted before settlement; a new request must re-scan references"));
      await journal.save(previous, true);
      return previous;
    }
    const references = await scanResourceReferences(root, budget);
    candidates = await scanManagedTools(root, budget);
    for (const candidate of candidates) entries.push(...candidate.entries);
    await validateProtectedTools(root, references, params.protectedToolPaths ?? [], budget);
    result.summary = { ...summarizeResources(budget, entries), protectedReferences: references.protectedReferences };
    for (const candidate of candidates) if (isProtectedTool(candidate, references)) candidate.state = "protected";
    result.candidates = publicCandidates(candidates);
    result.protectedEntries = candidates.filter((candidate) => candidate.state === "protected").length;
    if (references.protectAll) {
      block(result, new ResourceScanFailure("partial", references.reason ?? "Preparation protects all managed tools"));
      result.status = "blocked";
    } else {
      for (const candidate of candidates) {
        if (candidate.state === "protected") continue;
        budget.check();
        // acquireFileLock 自行加 .lock；传入与 toolBackend 完全相同的 *.lock key，实际目录为 *.lock.lock。
        await inspectResourcePath(root, candidate.path);
        let release: (() => Promise<void>) | undefined;
        try {
          release = await acquireFileLock(candidate.lockPath, [], 0, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "LCODE_FILE_LOCK_TIMEOUT") throw error;
          candidate.state = "protected";
          result.protectedEntries++;
          block(result, new ResourceScanFailure("partial", "Tool installation is locked; no lock was reclaimed"));
          result.status = result.deletedEntries ? "partial" : "blocked";
          continue;
        }
        try {
          const current = await scanResourceReferences(root, budget);
          await validateProtectedTools(root, current, params.protectedToolPaths ?? [], budget);
          result.summary.protectedReferences = current.protectedReferences;
          if (isProtectedTool(candidate, current)) {
            candidate.state = "protected";
            result.protectedEntries++;
            if (current.protectAll) {
              for (const remaining of candidates) if (remaining.state === "eligible") {
                remaining.state = "protected";
                result.protectedEntries++;
              }
              block(result, new ResourceScanFailure("partial", current.reason ?? "Preparation became active"));
              result.status = result.deletedEntries ? "partial" : "blocked";
              break;
            }
            continue;
          }
          if (params.dryRun) continue;
          if (budget.entries + candidate.entries.length > budget.limits.maxEntries) throw new ResourceScanFailure("partial", "GC deletion entry budget exhausted");
          result.candidates = publicCandidates(candidates);
          await journal.save(result, false);
          budget.check();
          await removeResourceTree(root, candidate.entries, budget);
          candidate.state = "deleted";
          result.deletedEntries++;
          result.candidates = publicCandidates(candidates);
          await journal.save(result, false);
        } finally { await release(); }
      }
    }
    result.candidates = publicCandidates(candidates);
    await journal.save(result, true);
    return result;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("stale-reference:")) throw error;
    block(result, resourceFailure(error));
    result.summary.protectedReferences ??= 0;
    for (const candidate of candidates) if (candidate.state === "eligible") candidate.state = "protected";
    result.candidates = publicCandidates(candidates);
    result.protectedEntries = candidates.filter((candidate) => candidate.state === "protected").length;
    if (journal) {
      try { await journal.save(result, true); }
      catch { result.status = "blocked"; result.summary.status = "unavailable"; result.summary.reason = "GC journal settlement could not be confirmed"; }
    }
    return result;
  } finally { await journal?.release(); }
}
