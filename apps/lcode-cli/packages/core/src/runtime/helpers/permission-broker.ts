import type {
  PermissionBrokerPort,
  PermissionBrokerRequest,
  PermissionBrokerResult,
} from "../deps.js";

interface ResolvablePermissionBroker extends PermissionBrokerPort {
  resolvePermission(requestIdOrToolCallId: string, result: PermissionBrokerResult): boolean;
}

interface InspectablePermissionBroker extends PermissionBrokerPort {
  listPendingRequests(): PermissionBrokerRequest[];
}

export function isResolvablePermissionBroker(
  broker: PermissionBrokerPort,
): broker is ResolvablePermissionBroker {
  return typeof (broker as Partial<ResolvablePermissionBroker>).resolvePermission === "function";
}

export function isInspectablePermissionBroker(
  broker: PermissionBrokerPort,
): broker is InspectablePermissionBroker {
  return typeof (broker as Partial<InspectablePermissionBroker>).listPendingRequests === "function";
}
