import type { RuntimeConsumerReference, RuntimeConsumerReleaseParams } from "@lcode/shared";
import type { RuntimeConsumerOwnerReceipt, RuntimeConsumerProcessOwner } from "../contract.js";
import type { RuntimeEnvironmentStore } from "./ports.js";

function matches(
  receipt: RuntimeConsumerOwnerReceipt,
  ref: RuntimeConsumerReleaseParams | RuntimeConsumerReference,
): boolean {
  return (
    ref.kind === "process" &&
    receipt.environmentId === ref.environmentId &&
    receipt.id === ref.id &&
    receipt.ownerId === ref.ownerId &&
    receipt.ownerGeneration === ref.ownerGeneration &&
    receipt.lease === ref.lease
  );
}
function sameOwner(left: RuntimeConsumerProcessOwner, right: RuntimeConsumerProcessOwner): boolean {
  return (
    left.runtimeInstanceId === right.runtimeInstanceId &&
    left.runtimeGeneration === right.runtimeGeneration &&
    left.startedAt === right.startedAt &&
    left.pid === right.pid &&
    left.workspacePath === right.workspacePath &&
    (left.workspaceIdentity?.trim() || "") === (right.workspaceIdentity?.trim() || "")
  );
}

/** 调用者持有环境锁；先保存收据再授予引用，避免写失败留下无 owner 的新 lease。 */
export async function retainProcessOwnerReceipt(
  store: RuntimeEnvironmentStore,
  ref: RuntimeConsumerReference,
  owner: RuntimeConsumerProcessOwner,
) {
  if (ref.kind !== "process" || ref.ownerId !== `runtime-agent-${owner.runtimeInstanceId}`)
    throw new Error("scope-mismatch: process reference does not match its actual runtime owner");
  const receipts = await store.listConsumerOwnerReceipts(ref.environmentId);
  const index = receipts.findIndex((receipt) => receipt.id === ref.id);
  const previous = receipts[index];
  if (previous && matches(previous, ref)) {
    if (!sameOwner(previous.processOwner, owner) || previous.exitConfirmedAt)
      throw new Error("stale-reference: process owner identity changed or already exited");
    return;
  }
  const receipt: RuntimeConsumerOwnerReceipt = {
    environmentId: ref.environmentId,
    revision: ref.revision,
    kind: "process",
    id: ref.id,
    ownerId: ref.ownerId,
    ownerGeneration: ref.ownerGeneration,
    lease: ref.lease,
    processOwner: owner,
  };
  if (index < 0) receipts.push(receipt);
  else receipts[index] = receipt;
  await store.saveConsumerOwnerReceipts(ref.environmentId, receipts);
}

/** 只在原进程树退出后的可信 callback 中调用；transport 断开或 PID 消失不能生成此收据。 */
export async function confirmStoredProcessExit(
  store: RuntimeEnvironmentStore,
  params: RuntimeConsumerReleaseParams,
  owner: RuntimeConsumerProcessOwner,
  stamp: () => string,
) {
  const receipts = await store.listConsumerOwnerReceipts(params.environmentId);
  const receipt = receipts.find((receipt) => matches(receipt, params));
  if (!receipt) {
    if (
      (await store.listConsumers(params.environmentId)).some(
        (ref) =>
          ref.state === "active" &&
          ref.kind === params.kind &&
          ref.id === params.id &&
          ref.ownerId === params.ownerId &&
          ref.ownerGeneration === params.ownerGeneration &&
          ref.lease === params.lease,
      )
    )
      throw new Error("process-unknown: active process reference has no matching owner receipt");
    return;
  }
  if (!sameOwner(receipt.processOwner, owner))
    throw new Error("stale-reference: process exit owner differs");
  if (receipt.exitConfirmedAt) return;
  receipt.exitConfirmedAt = stamp();
  await store.saveConsumerOwnerReceipts(params.environmentId, receipts);
}

/** 调用者持有环境锁且已授权 scope；只恢复真实退出后写入失败的精确 lease，不推断旧 owner。 */
export async function settleConfirmedProcessExits(
  store: RuntimeEnvironmentStore,
  environmentId: string,
  stamp: () => string,
) {
  const receipts = await store.listConsumerOwnerReceipts(environmentId);
  const refs = await store.listConsumers(environmentId);
  let changed = false;
  const next = refs.map((ref) => {
    if (
      ref.state !== "active" ||
      !receipts.some(
        (receipt) =>
          Boolean(receipt.exitConfirmedAt) &&
          receipt.revision === ref.revision &&
          matches(receipt, ref),
      )
    )
      return ref;
    changed = true;
    return { ...ref, state: "released" as const, updatedAt: stamp() };
  });
  if (changed) await store.saveConsumers(environmentId, next);
  return next;
}
