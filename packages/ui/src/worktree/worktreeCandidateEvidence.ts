import type { WorktreeIntegration } from "@lcode/services";
import {
  worktreeCandidateEvidenceSchema,
  worktreeValidationReceiptSchema,
  type RuntimeEnvironmentReference,
} from "@lcode/shared";

function sameEnvironment(left?: RuntimeEnvironmentReference, right?: RuntimeEnvironmentReference) {
  return (
    left?.environmentId === right?.environmentId &&
    left?.revision === right?.revision &&
    left?.manifestDigest === right?.manifestDigest
  );
}

/** ready 只是阶段；缺少精确 owner 收据时不能把 UI 确认项当成验证事实。 */
export function candidateEvidenceState(
  operation: WorktreeIntegration | null,
): "missing" | "passed" | "skipped" {
  if (!operation) return "missing";
  const parsed = worktreeCandidateEvidenceSchema.safeParse(operation.candidateEvidence);
  if (!parsed.success || !operation.validationReceipts?.length) return "missing";
  const evidence = parsed.data;
  if (
    evidence.candidateHead !== operation.candidateHead ||
    evidence.sourceHead !== operation.sourceHead ||
    evidence.targetHead !== operation.targetHead ||
    evidence.targetBranch !== operation.targetBranch ||
    evidence.environmentPolicy !== operation.environmentPolicy ||
    !sameEnvironment(evidence.environmentRef, operation.environmentRef) ||
    JSON.stringify(evidence.validationCommands) !== JSON.stringify(operation.validationCommands)
  )
    return "missing";
  if (
    evidence.environmentPolicy === "managed" &&
    (!evidence.environmentRef ||
      !evidence.manifestDigest ||
      evidence.manifestDigest !== operation.environmentRef?.manifestDigest)
  )
    return "missing";
  const receipts = operation.validationReceipts.map((receipt) =>
    worktreeValidationReceiptSchema.safeParse(receipt),
  );
  if (receipts.some((receipt) => !receipt.success)) return "missing";
  const verified = receipts.flatMap((receipt) => (receipt.success ? [receipt.data] : []));
  if (JSON.stringify(verified) !== JSON.stringify(evidence.validationReceipts)) return "missing";
  for (const receipt of verified) {
    if (
      receipt.candidateHead !== evidence.candidateHead ||
      receipt.candidateTree !== evidence.candidateTree ||
      receipt.sourceHead !== evidence.sourceHead ||
      receipt.targetHead !== evidence.targetHead ||
      receipt.targetBranch !== evidence.targetBranch ||
      receipt.environmentPolicy !== evidence.environmentPolicy ||
      !sameEnvironment(receipt.environmentRef, evidence.environmentRef) ||
      receipt.manifestDigest !== evidence.manifestDigest ||
      receipt.declarationDigest !== evidence.declarationDigest ||
      (evidence.environmentRef && receipt.revision !== evidence.environmentRef.revision)
    )
      return "missing";
  }
  const skipped = verified[0];
  if (!operation.validationCommands.length)
    return verified.length === 1 &&
      skipped?.outcome === "skipped" &&
      skipped.skipAcknowledged === true &&
      skipped.command === null
      ? "skipped"
      : "missing";
  return verified.length === operation.validationCommands.length &&
    verified.every(
      (receipt, index) =>
        receipt.outcome === "passed" &&
        receipt.exitCode === 0 &&
        receipt.command === operation.validationCommands[index],
    )
    ? "passed"
    : "missing";
}
