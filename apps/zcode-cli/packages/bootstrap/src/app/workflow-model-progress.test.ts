import assert from "node:assert/strict";
import test from "node:test";
import type { DwfRunSessionListItem } from "@zcode/adapters/storage";
import type { JournalStorePort } from "@zcode/dynamic-workflow";
import { reduceWorkflowRunsState } from "@zcode/shared/zcode-protocol-v4";
import { replayRunProgressFromEvents } from "./dynamic-workflow-run-replay.js";
import { toProgressPayload } from "./dynamic-workflow-run-launch.js";
import { snapshotOf, type RunRegistryEntry } from "./dynamic-workflow-run-observation.js";

test("live and cold progress preserve the same inherited reasoning and speed", () => {
  const selection = { providerId: "provider-a", modelId: "model-a", options: { reasoningLevel: "high", speed: "fast" } };
  const started = { type: "run-started" as const, runId: "run-1", caps: { maxConcurrency: 2 } };
  const live = toProgressPayload({ event: started, runId: "run-1", sequence: 1, concurrencyCeiling: 8,
    subagentSelection: selection, sessionSelection: selection });
  const replay = replayRunProgressFromEvents(
    { runId: "run-1", status: "running" } as DwfRunSessionListItem,
    [
      { sequence: 1, event: started },
      { sequence: 2, event: { type: "run-launched", inputId: "input-1", subagentSelection: selection, sessionSelection: selection } },
    ], 8,
  );
  assert.deepEqual(replay[0], live);
  const projected = reduceWorkflowRunsState(undefined, replay[0]!);
  assert.deepEqual(projected?.runs[0]?.subagentSelection, selection);
  assert.deepEqual(projected?.runs[0]?.sessionSelection, selection);
});

test("newly registered run exposes launch selection before its journal event exists", () => {
  const selection = { providerId: "provider-a", modelId: "model-a", options: { reasoningLevel: "high", speed: "fast" } };
  const entry = {
    controller: new AbortController(), startedAt: new Date(), cwd: "workspace", scriptText: "",
    subagentSelection: selection, sessionSelection: selection,
    settlement: Promise.resolve({ status: "stopped", reason: "user" }),
  } as RunRegistryEntry;
  const journal = {
    getRun: () => undefined,
    getEvents: () => { throw new Error("journal must not be read before launch"); },
  } as unknown as JournalStorePort;
  const snapshot = snapshotOf("run-1", new Map([["run-1", entry]]), journal);
  assert.deepEqual(snapshot?.subagentSelection, selection);
  assert.deepEqual(snapshot?.sessionSelection, selection);
});
