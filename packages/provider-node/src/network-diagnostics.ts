import { randomUUID } from "node:crypto";
import type { ProcessNetworkDiagnostic } from "@lcode/shared/process-diagnostic";

const MAX_OWNERS = 8;
const MAX_CONNECTIONS = 8;
const facts = new Map<string, ProcessNetworkDiagnostic>();

/** 有界诊断副本，不持有 Request、URL、账号、凭据或业务调度状态。 */
export class NetworkDiagnostics {
  private readonly facts: ProcessNetworkDiagnostic = {
    ownerId: randomUUID(),
    phase: "active",
    activeRequests: 0,
    started: 0,
    finished: 0,
    connections: [],
  };
  constructor() {
    facts.set(this.facts.ownerId, this.facts);
    while (facts.size > MAX_OWNERS) facts.delete(facts.keys().next().value!);
  }
  start(): void {
    this.facts.started++;
    this.facts.activeRequests++;
  }
  finish(): void {
    this.facts.finished++;
    this.facts.activeRequests--;
  }
  phase(phase: ProcessNetworkDiagnostic["phase"]): void {
    this.facts.phase = phase;
    if (phase === "closed")
      for (const connection of this.facts.connections) connection.phase = "retired";
  }
  connection = (
    connectionId: string,
    protocol: "h1" | "h2",
    phase: "connected" | "retired",
  ): void => {
    const previous = this.facts.connections.find((entry) => entry.connectionId === connectionId);
    if (previous) previous.phase = phase;
    else this.facts.connections.push({ connectionId, protocol, phase });
    if (this.facts.connections.length > MAX_CONNECTIONS) this.facts.connections.shift();
  };
}

export function getProviderNetworkDiagnostics(): ProcessNetworkDiagnostic[] {
  return [...facts.values()].map((entry) => ({
    ...entry,
    connections: entry.connections.map((connection) => ({ ...connection })),
  }));
}
