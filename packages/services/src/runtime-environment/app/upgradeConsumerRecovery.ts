import { resolve } from "node:path";
import { z } from "zod";
import {
  runtimeEnvironmentScopeSchema,
  type RuntimeConsumerReference,
  type RuntimeEnvironmentRecord,
  type RuntimeEnvironmentScope,
} from "@lcode/shared";
import type {
  RuntimeConsumerOwnerReceipt,
  RuntimeConsumerRetirement,
  RuntimeConsumerUpgradeRecoveryParams,
  RuntimeProcessOwnerObserver,
} from "../contract.js";
import { observeOrphanedSessionOwner } from "./discardConsumerEligibility.js";
import { assertEnvironmentScope } from "./preparationAdmission.js";
import type { RuntimeEnvironmentStore } from "./ports.js";

const text = z.string().trim().min(1).max(4096);
const requestSchema = runtimeEnvironmentScopeSchema
  .extend({
    environmentId: text,
    bindingId: text,
    requestId: text.max(512),
    expectedRevision: z.number().int().positive(),
    expectedManifestDigest: text.optional(),
    ownerScope: runtimeEnvironmentScopeSchema,
    writer: z.object({ workspacePath: text, ownerId: text, token: text }).strict(),
  })
  .strict();
const sameScope = (left: RuntimeEnvironmentScope, right: RuntimeEnvironmentScope) =>
  (left.workspaceIdentity?.trim() || "") === (right.workspaceIdentity?.trim() || "") &&
  (process.platform === "win32"
    ? resolve(left.workspacePath).toLowerCase() === resolve(right.workspacePath).toLowerCase()
    : resolve(left.workspacePath) === resolve(right.workspacePath));

/** 完整现代 receipt + 本 binding session + 实际 owner absent；只允许显式升级后续取得 writer。 */
export async function observeUpgradeableConsumer(
  record: RuntimeEnvironmentRecord,
  ref: RuntimeConsumerReference,
  refs: readonly RuntimeConsumerReference[],
  owners: readonly RuntimeConsumerOwnerReceipt[],
  ownerScope: RuntimeEnvironmentScope,
  observe?: RuntimeProcessOwnerObserver,
) {
  const sessions = new Set(
    refs
      .filter(
        (item) =>
          item.state === "active" &&
          item.kind === "session" &&
          item.revision === record.currentRevision &&
          item.ownerId === `binding:${record.bindingId}`,
      )
      .map((item) => item.id),
  );
  const eligible = await observeOrphanedSessionOwner(
    ref,
    record.currentRevision,
    sessions,
    owners,
    observe,
  );
  if (
    !eligible ||
    (!sameScope(eligible.orphanedOwner, ownerScope) &&
      !sameScope(eligible.orphanedOwner, record.scope))
  )
    return undefined;
  return eligible;
}

/** 原明确更新的行政退役，不把 PID 消失伪造成整棵进程树退出证明，不删除聊天或代码。 */
export async function retireOrphanedProcessesForUpgrade(
  store: RuntimeEnvironmentStore,
  input: RuntimeConsumerUpgradeRecoveryParams,
  stamp: () => string,
  observe?: RuntimeProcessOwnerObserver,
) {
  const params = requestSchema.parse(input);
  if (
    !sameScope(
      { workspacePath: params.writer.workspacePath },
      { workspacePath: params.workspacePath },
    ) ||
    params.writer.ownerId !== `upgrade:${params.bindingId}:${params.requestId}`
  )
    throw new Error(
      "scope-mismatch: orphan recovery requires the original upgrade checkout writer",
    );
  return store.lock(params.environmentId, async () => {
    const record = await store.readEnvironment(params.environmentId);
    if (!record) throw new Error("stale-reference: runtime environment is missing");
    assertEnvironmentScope(record, params);
    if (
      record.bindingId !== params.bindingId ||
      record.currentRevision !== params.expectedRevision ||
      (params.expectedManifestDigest !== undefined &&
        record.manifestDigest !== params.expectedManifestDigest)
    )
      throw new Error("stale-reference: orphan recovery binding or environment changed");
    if (
      record.status !== "needsUpdate" ||
      record.fenceIntent !== "upgrade" ||
      record.activeOperationId
    )
      throw new Error(
        "release-blocked: orphan recovery requires the settled explicit upgrade fence",
      );
    const refs = await store.listConsumers(params.environmentId);
    const owners = await store.listConsumerOwnerReceipts(params.environmentId);
    const candidates = [];
    for (const ref of refs) {
      if (ref.state !== "active" || ref.kind === "session") continue;
      const eligible = await observeUpgradeableConsumer(
        record,
        ref,
        refs,
        owners,
        params.ownerScope,
        observe,
      );
      if (!eligible) throw new Error("release-blocked: upgrade execution owner cannot be retired");
      candidates.push({ ref, ...eligible });
    }
    const audit = await store.listConsumerRetirements(params.environmentId);
    for (const { ref, orphanedOwner } of candidates) {
      const previous = audit.find((receipt) => receipt.id === ref.id);
      if (previous) {
        if (
          previous.reason !== "confirmed-environment-upgrade" ||
          previous.ownerId !== ref.ownerId ||
          previous.ownerGeneration !== ref.ownerGeneration ||
          previous.lease !== ref.lease ||
          previous.revision !== ref.revision ||
          previous.bindingId !== params.bindingId ||
          previous.requestId !== params.requestId
        )
          throw new Error("stale-reference: upgrade orphan recovery journal differs");
      } else {
        const receipt: RuntimeConsumerRetirement = {
          environmentId: ref.environmentId,
          revision: ref.revision,
          kind: "process",
          id: ref.id,
          ownerId: ref.ownerId,
          ownerGeneration: ref.ownerGeneration,
          lease: ref.lease,
          bindingId: params.bindingId,
          requestId: params.requestId,
          reason: "confirmed-environment-upgrade",
          retiredAt: stamp(),
          orphanedOwner: { processOwner: orphanedOwner, observedAt: stamp() },
        };
        audit.push(receipt);
      }
    }
    if (!candidates.length)
      return { removed: 0, remaining: refs.filter((ref) => ref.state === "active").length };
    // audit 先落盘，进程引用写失败时仍沿同 journal 重验并结算；session 引用始终保留。
    await store.saveConsumerRetirements(params.environmentId, audit);
    const ids = new Set(candidates.map(({ ref }) => ref.id));
    const next = refs.map((ref) =>
      ref.kind === "process" && ids.has(ref.id)
        ? { ...ref, state: "released" as const, updatedAt: stamp() }
        : ref,
    );
    await store.saveConsumers(params.environmentId, next);
    return {
      removed: candidates.length,
      remaining: next.filter((ref) => ref.state === "active").length,
    };
  });
}
