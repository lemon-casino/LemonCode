import { resolve } from "node:path";
import {
  runtimeEnvironmentServiceActionParamsSchema,
  type ManagedServiceReceipt,
  type RuntimeEnvironmentRecord,
  type RuntimeEnvironmentServiceActionParams,
  type RuntimeEnvironmentServiceActionResult,
} from "@lcode/shared";
import { hasServiceExitProof, serviceUrlOrigin } from "../domain/services.js";
import { identityKeyOf } from "./ports.js";
import {
  markUnknown,
  owned,
  type ServiceStageContext,
  type ServiceOwnerKey,
  type ServiceOwnerAction,
  type ServiceOwnerRequest,
  type ServiceOwnerChannel,
} from "./serviceStageOwner.js";

/** 同机 peer 只把请求送回原 owner；观察失败只派生 unknown，不篡改另一 Host 的事实。 */
export function createServiceOwnerControl(
  context: ServiceStageContext,
  local: {
    start(
      params: RuntimeEnvironmentServiceActionParams,
      onlyOwned: boolean,
    ): Promise<RuntimeEnvironmentServiceActionResult>;
    stop(
      params: RuntimeEnvironmentServiceActionParams,
    ): Promise<RuntimeEnvironmentServiceActionResult>;
  },
) {
  const owns = (key: ServiceOwnerKey) => Boolean(owned(context, key));
  const unknown = (receipt: ManagedServiceReceipt): ManagedServiceReceipt =>
    markUnknown(receipt).receipt!;
  function acknowledged(
    record: RuntimeEnvironmentRecord,
    receipt: ManagedServiceReceipt,
  ): ManagedServiceReceipt {
    if (hasServiceExitProof(receipt)) return { ...receipt, urls: [] };
    const owner = owned(context, receipt);
    if (
      !owner ||
      owner.exit ||
      (receipt.state === "running" && context.processes?.isAlive?.(receipt) === false)
    )
      return unknown(receipt);
    if (receipt.state !== "running") return { ...receipt, urls: [] };
    const urls = receipt.urls.map(serviceUrlOrigin);
    if (
      !receipt.healthCheckedAt ||
      !urls.length ||
      urls.some((url) => !url) ||
      receipt.environmentId !== record.environmentId
    )
      return unknown(receipt);
    return { ...receipt, urls: urls as string[] };
  }
  function sameScope(
    record: RuntimeEnvironmentRecord,
    params: RuntimeEnvironmentServiceActionParams,
  ): boolean {
    const canonical = (path: string) =>
      process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
    return (
      identityKeyOf(record.scope) === identityKeyOf(params) &&
      canonical(record.scope.workspacePath) === canonical(params.workspacePath)
    );
  }
  async function handleOwnerRequest(
    action: ServiceOwnerAction,
    raw: ServiceOwnerRequest,
  ): Promise<RuntimeEnvironmentServiceActionResult> {
    const params = runtimeEnvironmentServiceActionParamsSchema.parse(raw);
    if (params.expectedGeneration === undefined)
      return { status: "blocked", reason: "process-unknown: exact owner generation is required" };
    const checked = await context.store.lock(params.environmentId, async () => {
      const record = await context.store.readEnvironment(params.environmentId);
      const receipt = await context.store.readServiceReceipt(
        params.environmentId,
        params.serviceId,
      );
      if (
        !record ||
        !sameScope(record, params) ||
        record.currentRevision !== params.expectedRevision ||
        !receipt ||
        receipt.generation !== params.expectedGeneration ||
        !owns(receipt)
      )
        return undefined;
      return { record, receipt: acknowledged(record, receipt) };
    });
    if (!checked)
      return {
        status: "blocked",
        reason: "process-unknown: requested service does not belong to this owner",
      };
    if (action === "query")
      return {
        status: checked.receipt.state === "unknown" ? "blocked" : "reused",
        receipt: checked.receipt,
      };
    if (action === "start") return local.start(params, true);
    return local.stop(params);
  }
  async function forwardResult(
    action: "start" | "stop",
    params: RuntimeEnvironmentServiceActionParams,
    result: RuntimeEnvironmentServiceActionResult,
  ): Promise<RuntimeEnvironmentServiceActionResult> {
    const receipt = result.receipt;
    if (!receipt || receipt.state !== "unknown" || owns(receipt) || !context.ownerChannel)
      return result;
    const response = await context.ownerChannel
      .request(action, { ...params, expectedGeneration: receipt.generation })
      .catch(() => undefined);
    if (
      !response?.receipt ||
      response.receipt.environmentId !== params.environmentId ||
      response.receipt.serviceId !== params.serviceId ||
      response.receipt.generation !== receipt.generation
    )
      return result;
    return response;
  }
  async function reconcileReceipt(
    record: RuntimeEnvironmentRecord,
    receipt: ManagedServiceReceipt,
  ): Promise<ManagedServiceReceipt> {
    if (hasServiceExitProof(receipt)) return { ...receipt, urls: [] };
    if (owns(receipt)) return acknowledged(record, receipt);
    const response = await context.ownerChannel
      ?.request("query", {
        ...record.scope,
        environmentId: record.environmentId,
        serviceId: receipt.serviceId,
        expectedRevision: record.currentRevision,
        expectedGeneration: receipt.generation,
        requestId: `owner-query-${receipt.generation}`,
      })
      .catch(() => undefined);
    const confirmed = response?.receipt;
    if (
      !confirmed ||
      confirmed.environmentId !== receipt.environmentId ||
      confirmed.serviceId !== receipt.serviceId ||
      confirmed.generation !== receipt.generation ||
      confirmed.revision !== receipt.revision ||
      confirmed.stateRevision !== receipt.stateRevision ||
      response?.status === "blocked"
    )
      return unknown(receipt);
    if (hasServiceExitProof(confirmed)) return { ...confirmed, urls: [] };
    if (confirmed.state !== "running") return { ...confirmed, urls: [] };
    const urls = confirmed.urls.map(serviceUrlOrigin);
    return confirmed.healthCheckedAt && urls.length && urls.every(Boolean)
      ? { ...confirmed, urls: urls as string[] }
      : unknown(receipt);
  }
  return {
    owns,
    handleOwnerRequest,
    forwardResult,
    reconcileReceipt,
    attachOwnerChannel(channel: ServiceOwnerChannel): void {
      if (context.ownerChannel) throw new Error("service owner channel is already attached");
      context.ownerChannel = channel;
    },
  };
}
