import type { WorktreeCandidateEvidence, WorktreeValidationReceipt } from "@lcode/shared";
import type { WorktreeIntegration } from "../contract.js";
import type { WorktreeContext } from "./ports.js";
import { resolveBindingRuntime, sameEnvironment } from "./runtimeEnvironment.js";

export async function candidateFacts(context: WorktreeContext, operation: WorktreeIntegration) {
  const binding = await context.store.readBinding(operation.bindingId);
  if (!binding || binding.status !== "ready") throw new Error("Candidate binding is not ready");
  const source = await context.git.inspect(binding.checkoutPath);
  if (source.head !== operation.sourceHead || source.branch !== binding.branch || source.commonDirectory !== binding.commonDirectory)
    throw new Error("Integration source HEAD or ownership changed after review");
  const target = await context.git.resolveTarget(operation.repositoryPath ?? binding.repositoryRoot, operation.targetBranch);
  if (target.head !== operation.targetHead) throw new Error("Target HEAD changed after integration review");
  const head = await context.git.command(operation.checkoutPath, ["rev-parse", "HEAD"]);
  const dirty = await context.git.command(operation.checkoutPath, ["status", "--porcelain", "--untracked-files=all"]);
  if (head !== operation.candidateHead || dirty) throw new Error("Integration candidate changed or has uncommitted changes");
  const tree = await context.git.command(operation.checkoutPath, ["rev-parse", "HEAD^{tree}"]);
  return { binding, head, tree, declarationDigest: await context.declarationDigest(operation.checkoutPath) };
}

export function receiptMatches(receipt: WorktreeValidationReceipt, evidence: WorktreeCandidateEvidence) {
  return receipt.candidateHead === evidence.candidateHead && receipt.candidateTree === evidence.candidateTree &&
    receipt.sourceHead === evidence.sourceHead && receipt.targetHead === evidence.targetHead && receipt.targetBranch === evidence.targetBranch &&
    receipt.environmentPolicy === evidence.environmentPolicy && sameEnvironment(receipt.environmentRef, evidence.environmentRef) &&
    receipt.manifestDigest === evidence.manifestDigest && receipt.declarationDigest === evidence.declarationDigest &&
    receipt.revision === evidence.environmentRef?.revision;
}

/** ready 是显示阶段，不是授权；每次发布都重读 Git 和环境 owner 的精确事实。 */
export async function assertCandidateEvidence(context: WorktreeContext, operation: WorktreeIntegration) {
  const evidence = operation.candidateEvidence;
  if (!evidence || !operation.validationReceipts?.length || !evidence.validationCommands)
    throw new Error("Candidate validation evidence is missing; review and validate again");
  const facts = await candidateFacts(context, operation);
  const policy = operation.environmentPolicy ?? (facts.binding.environmentRef ? "managed" : "local");
  if (evidence.candidateHead !== facts.head || evidence.candidateTree !== facts.tree || evidence.sourceHead !== operation.sourceHead ||
    evidence.targetHead !== operation.targetHead || evidence.targetBranch !== operation.targetBranch || evidence.environmentPolicy !== policy ||
    evidence.declarationDigest !== facts.declarationDigest || !sameEnvironment(evidence.environmentRef, operation.environmentRef) ||
    JSON.stringify(evidence.validationCommands) !== JSON.stringify(operation.validationCommands) ||
    JSON.stringify(evidence.validationReceipts) !== JSON.stringify(operation.validationReceipts))
    throw new Error("Candidate validation evidence is stale; review and validate again");
  if (policy === "managed") {
    const runtime = await resolveBindingRuntime(context, { id: operation.bindingId, checkoutPath: operation.checkoutPath, environmentRef: operation.environmentRef, environmentPolicy: "managed" });
    if (!runtime || runtime.manifestDigest !== evidence.manifestDigest) throw new Error("Candidate environment manifest is stale");
  } else if (operation.environmentRef || evidence.manifestDigest) throw new Error("Local candidate cannot reuse managed environment evidence");
  const receipts = evidence.validationReceipts;
  if (!receipts.every((receipt) => receiptMatches(receipt, evidence))) throw new Error("Candidate validation receipt does not match its evidence");
  const skipped = receipts.length === 1 && receipts[0]!.outcome === "skipped" && receipts[0]!.skipAcknowledged === true && receipts[0]!.command === null && receipts[0]!.exitCode === null;
  const passed = operation.validationCommands.length > 0 && receipts.length === operation.validationCommands.length && receipts.every((receipt, index) => receipt.command === operation.validationCommands[index] && receipt.outcome === "passed" && receipt.exitCode === 0);
  if (!skipped && !passed) throw new Error("Candidate lacks passed commands or an explicit skip receipt");
}
