import { importedAskRecord } from "./imported-cache.js";
import { WorkflowError } from "./types.js";
import type { Actor, AskNode, Deferred, SchedulerHost } from "./scheduler-types.js";
import type { InstanceRef, NodeRecord } from "./types.js";

export function applyTaskSupplement(instructions: string, supplement: string | undefined): string {
  return supplement === undefined
    ? instructions
    : `${instructions}\n\nUser revisions for this task:\n${supplement}`;
}

export function settleImportedAsk(input: {
  instance: InstanceRef;
  actor: Actor;
  seq: number;
  hash: string;
  deferred: Deferred<unknown>;
  host: SchedulerHost;
}): boolean {
  const { instance, actor, seq, hash, deferred, host } = input;
  if (host.invalidatesImportedAsk(instance)) {
    actor.imported?.invalidate();
    return false;
  }
  const entry = host.importCacheClosed()
    ? actor.imported?.takeIfPure(seq, hash)
    : actor.imported?.take(seq, hash);
  if (entry === undefined) return false;
  host.driver.journal.putNode(importedAskRecord(host.runId, instance, actor.ref, seq, hash, entry));
  host.record({ type: "node-settled", instance, outcome: "ok", cached: true });
  deferred.resolve(entry.result);
  return true;
}

export function releaseCachedAsk(
  host: SchedulerHost,
  instance: InstanceRef,
  recorded: NodeRecord,
  deferred: Deferred<unknown>,
): void {
  if (recorded.status === "completed") {
    host.record({ type: "node-settled", instance, outcome: "ok", cached: true });
    deferred.resolve(recorded.result);
  } else {
    host.record({ type: "node-settled", instance, outcome: "failed", cached: true, error: recorded.error });
    deferred.reject(WorkflowError.fromJSON(recorded.error!));
  }
}

export function nodeRecordFor(
  host: SchedulerHost,
  node: AskNode,
  outcome: { status: "completed"; result: unknown } | { status: "failed"; error: NodeRecord["error"] },
): NodeRecord {
  const record: NodeRecord = {
    runId: host.runId,
    siteId: node.instance.siteId,
    ordinal: node.instance.ordinal,
    kind: "ask",
    actorSiteId: node.actor.ref.siteId,
    actorOrdinal: node.actor.ref.ordinal,
    actorSeq: node.actorSeq,
    inputHash: node.hash,
    status: outcome.status,
  };
  if (outcome.status === "completed") record.result = outcome.result;
  else record.error = outcome.error;
  if (node.lastStats !== undefined) record.stats = node.lastStats;
  return record;
}
