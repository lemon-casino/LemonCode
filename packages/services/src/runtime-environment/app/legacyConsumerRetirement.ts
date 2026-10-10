import { resolve } from "node:path";
import { z } from "zod";
import { runtimeConsumerSessionDeletionParamsSchema } from "@lcode/shared";
import type {
  RuntimeConsumerLegacyDeletionParams,
  RuntimeConsumerRetirement,
  RuntimeProcessOwnerObserver,
} from "../contract.js";
import type { RuntimeEnvironmentStore } from "./ports.js";
import { assertEnvironmentScope } from "./preparationAdmission.js";
import { discardConsumerEligibility } from "./discardConsumerEligibility.js";

const text = z.string().trim().min(1).max(4096);
const requestSchema = runtimeConsumerSessionDeletionParamsSchema
  .extend({
    requestId: text.max(512),
    expectedRevision: z.number().int().nonnegative(),
    expectedManifestDigest: text.optional(),
    repositoryRoot: text,
    writer: z.object({ workspacePath: text, ownerId: text, token: text }).strict(),
  })
  .strict();
const canonical = (path: string) =>
  process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);

/** 用户确认删除的旧数据迁移；不是退出证明。仅在 Worktree owner 的 writer/精确历史清理后调用。 */
export async function retireLegacyProcessesForDeletion(
  store: RuntimeEnvironmentStore,
  input: RuntimeConsumerLegacyDeletionParams,
  stamp: () => string,
  observeProcessOwner?: RuntimeProcessOwnerObserver,
) {
  const params = requestSchema.parse(input);
  if (
    params.writer.ownerId !== `discard:${params.requestId}` ||
    ![params.workspacePath, params.repositoryRoot].some(
      (path) => canonical(path) === canonical(params.writer.workspacePath),
    )
  )
    throw new Error(
      "scope-mismatch: legacy retirement requires the original discard checkout writer",
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
      throw new Error("stale-reference: legacy retirement binding or environment changed");
    const refs = await store.listConsumers(params.environmentId);
    const owners = await store.listConsumerOwnerReceipts(params.environmentId);
    const sessions = new Set(params.sessionIds);
    const candidates = [];
    for (const ref of refs) {
      if (ref.state !== "active" || ref.kind === "session") continue;
      const eligible = await discardConsumerEligibility(
        ref,
        record.currentRevision,
        sessions,
        owners,
        observeProcessOwner,
      );
      // stop 后 owner 可能变化；取得 writer 并清理历史后仍必须在本次环境锁内复核。
      if (!eligible)
        throw new Error(
          "release-blocked: execution owner cannot be retired after session deletion",
        );
      candidates.push({ ref, ...eligible });
    }
    const remaining = () => refs.filter((ref) => ref.state === "active").length;
    if (!candidates.length) return { removed: 0, remaining: remaining() };
    // 行政退役只在已确认 discard 的持久 fence 和精确历史清理边界执行，不伪造退出收据。
    if (
      record.status !== "releasing" ||
      record.fenceIntent !== "discard" ||
      refs.some((ref) => ref.state === "active" && ref.kind === "session" && sessions.has(ref.id))
    )
      throw new Error(
        "release-blocked: legacy retirement requires settled session deletion and discard fence",
      );
    const audit = await store.listConsumerRetirements(params.environmentId);
    for (const { ref, orphanedOwner } of candidates) {
      const previous = audit.find((receipt) => receipt.id === ref.id);
      if (previous) {
        if (
          previous.ownerId !== ref.ownerId ||
          previous.ownerGeneration !== ref.ownerGeneration ||
          previous.lease !== ref.lease ||
          previous.revision !== ref.revision ||
          previous.bindingId !== params.bindingId ||
          previous.requestId !== params.requestId
        )
          throw new Error("stale-reference: legacy retirement journal differs");
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
          reason: "confirmed-worktree-discard",
          retiredAt: stamp(),
          ...(orphanedOwner
            ? { orphanedOwner: { processOwner: orphanedOwner, observedAt: stamp() } }
            : {}),
        };
        audit.push(receipt);
      }
    }
    await store.saveConsumerRetirements(params.environmentId, audit);
    const ids = new Set(candidates.map(({ ref }) => ref.id));
    const next = refs.map((ref) =>
      ids.has(ref.id) && ref.kind === "process"
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
