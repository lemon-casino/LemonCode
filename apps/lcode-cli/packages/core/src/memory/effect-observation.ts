import { createHash } from "node:crypto";
import type { MemoryEffectTurn, SessionEvent } from "@lcode/contracts";
import { SessionEventType } from "@lcode/contracts";
import type { MemoryRecallResult } from "./recall/types.js";

export function memoryEffectWorkspaceKey(
  workspaceIdentity: string | undefined,
  workspacePath: string,
): string {
  return `sha256:${createHash("sha256")
    .update(workspaceIdentity?.trim() || workspacePath)
    .digest("hex")}`;
}

export function freezeMemoryInjection(
  results: readonly MemoryRecallResult[],
): MemoryEffectTurn["entries"] {
  return results.slice(0, 4).map((result) =>
    Object.freeze({
      fileName: result.filename,
      sourceHash: /^sha256:[a-f0-9]{64}$/u.test(result.sourceHash ?? "")
        ? result.sourceHash!
        : null,
      injectedCharacters: result.content.length,
      // 完整记忆可含超过 4000 个匹配词；饱和计数避免 schema 拒绝整轮观测。
      matchedTermCount: Math.min(4000, result.matchedTerms?.length ?? 0),
      metadataMatchCount: Math.min(4000, result.metadataMatches?.length ?? 0),
    }),
  );
}

/** 只关联真正结算的核验；普通 TurnComplete/exit 0 以及 legacy fail-open 不构成核验通过。 */
export function memoryEffectVerification(
  events: readonly SessionEvent[],
  sessionId: string,
  turnId: string,
): Pick<MemoryEffectTurn, "verification" | "verificationEvidenceId" | "verificationBasis"> {
  const event = [...events]
    .reverse()
    .find(
      (entry) =>
        entry.sessionId === sessionId &&
        entry.type === SessionEventType.TargetCompletionVerification &&
        ((record(entry.payload) ? entry.payload.anchorTurnId : undefined) ?? entry.turnId) ===
          turnId,
    );
  if (!event || !record(event.payload)) return { verification: "unknown" };
  const payload = event.payload;
  if (!record(payload.verification))
    return { verification: "unknown", verificationEvidenceId: event.id };
  const verification = payload.verification;
  const strict = record(verification.evidenceSummary);
  const basis = strict ? ("strict-evidence" as const) : ("model" as const);
  const outcome = strict
    ? (verification.evidenceSummary as Record<string, unknown>).outcome
    : undefined;
  const reference = { verificationEvidenceId: event.id, verificationBasis: basis };
  if (payload.status !== "completed") return { verification: "unknown", ...reference };
  if ((!strict || outcome === "pass") && verification.passed === true)
    return { verification: "passed", ...reference };
  if ((!strict || outcome === "notSatisfied") && verification.passed === false)
    return { verification: "failed", ...reference };
  return { verification: "unknown", ...reference };
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
