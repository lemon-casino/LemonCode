import type { WorktreeCandidateEvidence, WorktreeValidationReceipt } from "@lcode/shared";
import type { CheckoutLease, WorktreeCommandRunner, WorktreeIntegration } from "../contract.js";
import type { WorktreeContext } from "./ports.js";
import { candidateFacts, assertCandidateEvidence } from "./candidateEvidence.js";
import {
  environmentReference,
  failedEnvironmentReference,
  resolveBindingRuntime,
} from "./runtimeEnvironment.js";

export async function validateIntegrationCandidate(
  context: WorktreeContext,
  operation: WorktreeIntegration,
  run: WorktreeCommandRunner,
  writer: CheckoutLease,
  skipValidation = false,
): Promise<WorktreeIntegration> {
  const save = async (value: WorktreeIntegration) => {
    const updated = { ...value, updatedAt: new Date().toISOString() };
    await context.store.saveOperation(updated);
    return updated;
  };
  let value = await save({
    ...operation,
    status: "validating",
    candidateEvidence: undefined,
    validationReceipts: [],
    validationResults: [],
    error: undefined,
  });
  try {
    const facts = await candidateFacts(context, value);
    const policy = value.environmentPolicy ?? (facts.binding.environmentRef ? "managed" : "local");
    value = { ...value, environmentPolicy: policy };
    let frozenEnv: Record<string, string> | undefined;
    let manifestDigest: string | undefined;
    if (policy === "managed") {
      if (!context.prepareRuntimeEnvironment || !context.resolveRuntimeEnvironment)
        throw new Error("Candidate managed environment capability is unavailable");
      // 候选从其自己的声明准备；禁止复用任务环境。旧环境升级只发生在明确重验，不发生在发布对账。
      const requestId = `candidate:${value.id}:${context.store.key(JSON.stringify([facts.head, facts.declarationDigest, value.validationCommands, value.environmentRef ?? null]))}`;
      const environment = await context.prepareRuntimeEnvironment(
        {
          bindingId: value.bindingId,
          checkoutPath: value.checkoutPath,
          requestId,
          purpose: "integration-candidate",
          operation:
            value.environmentRef && value.environmentRef.revision > 0 ? "upgrade" : "prepare",
          environmentId: value.environmentRef?.environmentId,
          expectedRevision: value.environmentRef?.revision,
          expectedManifestDigest: value.environmentRef?.manifestDigest,
        },
        writer,
      );
      const reference = environmentReference(environment);
      if (reference.environmentId === facts.binding.environmentRef?.environmentId)
        throw new Error("Integration candidate must own an independent environment");
      value = await save({ ...value, environmentRef: reference });
      const resolved = await resolveBindingRuntime(context, {
        id: value.bindingId,
        checkoutPath: value.checkoutPath,
        environmentRef: reference,
        environmentPolicy: "managed",
      });
      frozenEnv = resolved?.env;
      manifestDigest = resolved?.manifestDigest;
    }
    if (!value.validationCommands.length && !skipValidation)
      return save({
        ...value,
        status: "awaiting-review",
        error:
          "No validation commands are available; explicit skipValidation acknowledgement is required",
      });
    const evidence: WorktreeCandidateEvidence = {
      candidateHead: facts.head,
      candidateTree: facts.tree,
      sourceHead: value.sourceHead,
      targetHead: value.targetHead,
      targetBranch: value.targetBranch,
      environmentPolicy: policy,
      environmentRef: value.environmentRef,
      manifestDigest,
      declarationDigest: facts.declarationDigest,
      validationCommands: [...value.validationCommands],
      validationReceipts: [],
      validatedAt: new Date().toISOString(),
    };
    const base = {
      candidateHead: evidence.candidateHead,
      candidateTree: evidence.candidateTree,
      sourceHead: evidence.sourceHead,
      targetHead: evidence.targetHead,
      targetBranch: evidence.targetBranch,
      environmentPolicy: policy,
      environmentRef: value.environmentRef,
      revision: value.environmentRef?.revision,
      manifestDigest,
      declarationDigest: facts.declarationDigest,
    };
    if (skipValidation) {
      const receipt: WorktreeValidationReceipt = {
        ...base,
        command: null,
        outcome: "skipped",
        exitCode: null,
        output: "Validation explicitly skipped; candidate is unverified.",
        outputTruncated: false,
        skipAcknowledged: true,
        verifiedAt: new Date().toISOString(),
      };
      evidence.validationReceipts = [receipt];
      value = await save({ ...value, validationReceipts: [receipt] });
    } else {
      for (const command of value.validationCommands) {
        let result;
        try {
          result = await run(value.checkoutPath, command, undefined, frozenEnv);
        } catch (error) {
          result = { exitCode: 1, output: error instanceof Error ? error.message : String(error) };
        }
        const bounded = {
          exitCode: result.exitCode,
          output: result.output.slice(-65536),
          outputTruncated: result.outputTruncated === true || result.output.length > 65536,
        };
        const receipt: WorktreeValidationReceipt = {
          ...base,
          command,
          ...bounded,
          outcome: result.exitCode === 0 ? "passed" : "failed",
          verifiedAt: new Date().toISOString(),
        };
        evidence.validationReceipts.push(receipt);
        value = await save({
          ...value,
          validationResults: [...value.validationResults, { command, ...bounded }],
          validationReceipts: [...evidence.validationReceipts],
        });
        if (result.exitCode !== 0)
          return save({
            ...value,
            status: "validation-failed",
            error: "Integration validation failed",
          });
      }
    }
    value = { ...value, candidateEvidence: evidence };
    try {
      await assertCandidateEvidence(context, value);
    } catch (error) {
      return save({
        ...value,
        candidateEvidence: undefined,
        status: "awaiting-review",
        error: `Validation changed the reviewed candidate or its prerequisites: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    return save({ ...value, status: "ready" });
  } catch (error) {
    // 与普通工作树准备一致：失败也可能已分配资源，必须保存零代清理引用；已有正代不能降级。
    const allocated = failedEnvironmentReference(error);
    if (!value.environmentRef && allocated) value = { ...value, environmentRef: allocated };
    return save({
      ...value,
      candidateEvidence: undefined,
      status: "validation-failed",
      error: `Candidate validation prerequisite failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}
