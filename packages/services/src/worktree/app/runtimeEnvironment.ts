import { runtimeEnvironmentReferenceSchema, runtimeEnvironmentBindingReferenceSchema } from "@lcode/shared";
import type { RuntimeEnvironmentBindingReference } from "@lcode/shared";
import type { CheckoutLease, PreparedWorktreeRuntime, WorktreeBinding, WorktreeRuntimePorts } from "../contract.js";
import type { WorktreeContext } from "./ports.js";

export function environmentReference(value: PreparedWorktreeRuntime) {
  if (!value.manifestDigest?.trim()) throw new Error("Managed environment manifest digest is missing");
  return runtimeEnvironmentReferenceSchema.parse({ environmentId: value.environmentId, revision: value.revision, manifestDigest: value.manifestDigest });
}

export function sameEnvironment(a: RuntimeEnvironmentBindingReference | undefined, b: RuntimeEnvironmentBindingReference | undefined) {
  return a?.environmentId === b?.environmentId && a?.revision === b?.revision && a?.manifestDigest === b?.manifestDigest;
}

export async function resolveBindingRuntime(context: WorktreeContext, binding: Pick<WorktreeBinding, "id" | "checkoutPath" | "environmentRef" | "environmentPolicy">) {
  if (!binding.environmentRef) {
    if (binding.environmentPolicy === "managed") throw new Error("Managed worktree environment reference is missing");
    return undefined;
  }
  if (!context.resolveRuntimeEnvironment) throw new Error("Managed environment resolution port is unavailable");
  const result = await context.resolveRuntimeEnvironment({ bindingId: binding.id, checkoutPath: binding.checkoutPath, environmentRef: binding.environmentRef });
  const reference = environmentReference(result);
  if (reference.environmentId !== binding.environmentRef.environmentId || reference.revision !== binding.environmentRef.revision || (binding.environmentRef.manifestDigest && reference.manifestDigest !== binding.environmentRef.manifestDigest))
    throw new Error("Managed environment reference or manifest is stale");
  return result;
}

export async function prepareBindingRuntime(context: WorktreeContext, binding: WorktreeBinding, writer: CheckoutLease) {
  if (binding.environmentRef && binding.environmentRef.revision > 0) return { binding, environment: await resolveBindingRuntime(context, binding) };
  if (!binding.environmentRef && binding.environmentPolicy !== "managed") return { binding, environment: undefined };
  if (!context.prepareRuntimeEnvironment || !context.resolveRuntimeEnvironment)
    throw new Error("Managed runtime environment capability is unavailable");
  let environment: PreparedWorktreeRuntime;
  try {
    environment = await context.prepareRuntimeEnvironment({ bindingId: binding.id, checkoutPath: binding.checkoutPath, requestId: binding.requestId, purpose: "worktree", environmentId: binding.environmentRef?.environmentId }, writer);
  } catch (error) {
    // 工具/依赖失败也可能已分配环境，保留 revision=0 引用才能在重试或删除时对账资源。
    const reference = failedEnvironmentReference(error);
    if (reference) await context.store.saveBinding({ ...binding, environmentRef: reference });
    throw error;
  }
  const value = {
    ...binding,
    environmentRef: environmentReference(environment),
    preparation: binding.preparation ? { ...binding.preparation, toolSource: environment.toolSource } : undefined,
  };
  await context.store.saveBinding(value);
  return { binding: value, environment };
}

export function failedEnvironmentReference(error: unknown) {
  if (!error || typeof error !== "object" || !("operation" in error)) return undefined;
  const operation = error.operation;
  if (!operation || typeof operation !== "object" || !("environmentId" in operation)) return undefined;
  const parsed = runtimeEnvironmentBindingReferenceSchema.safeParse({ environmentId: operation.environmentId, revision: 0 });
  return parsed.success ? parsed.data : undefined;
}

export async function cancelBindingRuntime(context: WorktreeContext, binding: WorktreeBinding) {
  if (!binding.environmentRef && binding.environmentPolicy !== "managed") return;
  if (!context.prepareRuntimeEnvironment) throw new Error("Managed environment cancellation port is unavailable");
  try {
    await context.prepareRuntimeEnvironment({ bindingId: binding.id, checkoutPath: binding.checkoutPath, requestId: binding.requestId, purpose: "worktree", environmentId: binding.environmentRef?.environmentId, cancel: true });
  } catch (error) {
    const reference = failedEnvironmentReference(error);
    if (reference) {
      const latest = await context.store.readBinding(binding.id);
      if (latest && !latest.environmentRef) await context.store.saveBinding({ ...latest, environmentRef: reference });
      const operation = (error as { operation?: { status?: string } }).operation;
      if (operation?.status === "cancelled" || operation?.status === "running") return;
    }
    throw error;
  }
}

type ReleaseRequest = Parameters<NonNullable<WorktreeRuntimePorts["releaseRuntimeEnvironment"]>>[0];
export async function releaseBindingRuntime(context: WorktreeContext, binding: WorktreeBinding, requestId: string, intent: ReleaseRequest["intent"], phase: ReleaseRequest["phase"], candidate?: { checkoutPath: string; environmentRef?: RuntimeEnvironmentBindingReference }) {
  const environmentRef = candidate ? candidate.environmentRef : binding.environmentRef;
  if (!environmentRef) {
    if (!candidate && binding.environmentPolicy === "managed") throw new Error("Managed environment reference is missing during release");
    return;
  }
  if (!context.releaseRuntimeEnvironment) throw new Error("Managed environment release port is unavailable");
  const result = await context.releaseRuntimeEnvironment({ binding, bindingId: binding.id, checkoutPath: candidate?.checkoutPath ?? binding.checkoutPath, requestId, environmentRef, intent, phase });
  if (result.status !== "completed") throw new Error(`Environment releaseBlocked: ${result.reason ?? phase}`);
}

/** Git 文件恢复不等于运行环境恢复；新引用先落盘，CAS 和消费者迁移结算后才允许 ready。 */
export async function rebuildBindingRuntime(context: WorktreeContext, binding: WorktreeBinding, requestId: string, operation: "restore" | "upgrade", writer: CheckoutLease) {
  const oldReference = binding.environmentRebuild?.oldEnvironmentRef ?? binding.environmentRef;
  if (!oldReference) {
    if (binding.environmentPolicy === "managed") throw new Error("Managed environment reference is missing during rebuild");
    return binding;
  }
  if (!context.prepareRuntimeEnvironment || !context.resolveRuntimeEnvironment || !context.rebindRuntimeEnvironmentSessions)
    throw new Error("Managed environment rebuild or session rebind port is unavailable");
  let value: WorktreeBinding = { ...binding, environmentRebuild: { ...binding.environmentRebuild, oldEnvironmentId: oldReference.environmentId, oldEnvironmentRef: oldReference, status: "pending" } };
  await context.store.saveBinding(value);
  if (!value.environmentRebuild?.newEnvironmentRef) {
    const environment = await context.prepareRuntimeEnvironment({ bindingId: value.id, checkoutPath: value.checkoutPath, requestId, purpose: "worktree", operation, environmentId: oldReference.environmentId, expectedRevision: oldReference.revision, expectedManifestDigest: oldReference.manifestDigest }, writer);
    const reference = environmentReference(environment);
    if (operation === "restore" && reference.environmentId === oldReference.environmentId)
      throw new Error("Restore must create a new runtime environment");
    if (operation === "upgrade" && (reference.environmentId !== oldReference.environmentId || reference.revision < oldReference.revision))
      throw new Error("Upgrade must preserve environment identity and advance its revision");
    value = { ...value, environmentRef: reference, environmentRebuild: { ...value.environmentRebuild, newEnvironmentRef: reference } };
    await context.store.saveBinding(value);
    await context.fault(`${operation}.after-environment`);
  }
  await resolveBindingRuntime(context, value);
  const result = await context.rebindRuntimeEnvironmentSessions({ binding: value, requestId, oldEnvironmentRef: oldReference, newEnvironmentRef: value.environmentRebuild!.newEnvironmentRef! });
  value = { ...value, environmentRebuild: { ...value.environmentRebuild, sessionIds: [...new Set(result.sessionIds)], status: "ready" } };
  await context.store.saveBinding(value);
  await context.fault(`${operation}.after-rebind`);
  return value;
}
