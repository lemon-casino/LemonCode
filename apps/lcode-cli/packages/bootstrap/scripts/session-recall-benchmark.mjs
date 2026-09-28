import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { createSqliteSessionStore } from "@lcode/adapters/storage";
import {
  SESSION_HISTORY_AUTO_RECALL_BOUNDS,
  searchSessionHistory,
} from "@lcode/core/session-history-search";
import { evaluateSessionRecallBenchmark } from "../../../scripts/session-recall-benchmark-stats.mjs";

const CORPUS = Object.freeze({
  currentSessions: 1,
  priorSessions: 9,
  messagesPerPriorSession: 64,
  partsPerMessage: 2,
  queryCount: 5,
});
const WARMUP_RUNS = 25;
const MEASURED_RUNS = 200;
const THRESHOLDS = Object.freeze({ p95Ms: 150, p99Ms: 300 });
const WORKSPACE_ROOT = "C:\\benchmark\\session-recall";
const CURRENT_SESSION_ID = "benchmark_current";
const QUERIES = [
  "bounded snapshot",
  "架构召回",
  "sessionRecall",
  "workspace_identity",
  "packages core",
];

let store;
let temporaryDirectory;
try {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "lcode-session-recall-benchmark-"));
  store = createSqliteSessionStore({ dbPath: join(temporaryDirectory, "sessions.db") });
  await seedCorpus(store);

  const invariantFailures = [];
  const coldStart = performance.now();
  const coldOutput = await runSearch(store, QUERIES[0]);
  const coldMs = performance.now() - coldStart;
  invariantFailures.push(...validateOutput(coldOutput, "cold"));

  for (let index = 0; index < WARMUP_RUNS; index += 1) {
    const output = await runSearch(store, QUERIES[index % QUERIES.length]);
    invariantFailures.push(...validateOutput(output, "warmup"));
  }

  const durations = [];
  for (let index = 0; index < MEASURED_RUNS; index += 1) {
    const startedAt = performance.now();
    const output = await runSearch(store, QUERIES[index % QUERIES.length]);
    durations.push(performance.now() - startedAt);
    invariantFailures.push(...validateOutput(output, "measured"));
  }

  const decision = evaluateSessionRecallBenchmark({
    durations,
    invariantFailures,
    thresholds: THRESHOLDS,
  });
  const report = {
    schemaVersion: 1,
    passed: decision.passed,
    decision: decision.passed ? "p4_fts_pruned" : "p4_review_permitted",
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    corpus: CORPUS,
    bounds: SESSION_HISTORY_AUTO_RECALL_BOUNDS,
    measurements: {
      coldMs: round(coldMs),
      warmupRuns: WARMUP_RUNS,
      measuredRuns: MEASURED_RUNS,
      ...decision.latency,
    },
    thresholds: THRESHOLDS,
    failures: decision.failures,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!decision.passed) process.exitCode = 1;
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ passed: false, errorName: error instanceof Error ? error.name : "UnknownError" })}\n`,
  );
  process.exitCode = 1;
} finally {
  try {
    store?.close();
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

async function seedCorpus(sessionStore) {
  await sessionStore.createSession(sessionInput(CURRENT_SESSION_ID, CORPUS.priorSessions + 2));
  for (let sessionIndex = 0; sessionIndex < CORPUS.priorSessions; sessionIndex += 1) {
    const sessionID = `benchmark_prior_${sessionIndex}`;
    await sessionStore.createSession(sessionInput(sessionID, sessionIndex + 1));
    for (let messageIndex = 0; messageIndex < CORPUS.messagesPerPriorSession; messageIndex += 1) {
      const messageID = `benchmark_message_${sessionIndex}_${messageIndex}`;
      await sessionStore.saveMessage({
        agent: "build",
        id: messageID,
        role: "user",
        sessionID,
        time: { created: messageIndex + 1 },
      });
      for (let partIndex = 0; partIndex < CORPUS.partsPerMessage; partIndex += 1) {
        await sessionStore.savePart({
          id: `benchmark_part_${sessionIndex}_${messageIndex}_${partIndex}`,
          messageID,
          sessionID,
          text: benchmarkText(sessionIndex, messageIndex, partIndex),
          type: "text",
        });
      }
    }
  }
}

function sessionInput(id, time) {
  return {
    id,
    projectID: "benchmark_project",
    taskType: "interactive",
    slug: id,
    directory: WORKSPACE_ROOT,
    title: `Bounded snapshot 架构召回 ${id}`,
    version: "benchmark",
    time: { created: time, updated: time },
  };
}

function benchmarkText(sessionIndex, messageIndex, partIndex) {
  const marker = `s${sessionIndex}_m${messageIndex}_p${partIndex}`;
  return [
    "架构召回 bounded snapshot sessionRecall workspace_identity packages core",
    "deterministic transcript payload for lexical ranking and bounded projection",
    "camelCaseToken snake_case_token path/packages/core/session-context",
    marker,
    "fixed filler segment ".repeat(7),
  ].join(" ");
}

function runSearch(sessionStore, query) {
  return searchSessionHistory({
    abortSignal: new AbortController().signal,
    bounds: SESSION_HISTORY_AUTO_RECALL_BOUNDS,
    currentSessionId: CURRENT_SESSION_ID,
    query,
    requestedLimit: 3,
    sessionStore,
    workspaceRoot: WORKSPACE_ROOT,
  });
}

function validateOutput(output, phase) {
  if (output.status !== "ok") return [`${phase}_unavailable`];
  const failures = [];
  if (output.matches.length === 0) failures.push(`${phase}_empty_matches`);
  if (output.matches.length > SESSION_HISTORY_AUTO_RECALL_BOUNDS.resultLimit) {
    failures.push(`${phase}_result_limit_exceeded`);
  }
  if (output.candidateSessionCount > SESSION_HISTORY_AUTO_RECALL_BOUNDS.candidateLimit) {
    failures.push(`${phase}_candidate_limit_exceeded`);
  }
  if (output.scannedSessionCount > SESSION_HISTORY_AUTO_RECALL_BOUNDS.candidateLimit) {
    failures.push(`${phase}_scan_limit_exceeded`);
  }
  if (output.projectedCharacterCount > SESSION_HISTORY_AUTO_RECALL_BOUNDS.totalCharacterLimit) {
    failures.push(`${phase}_projection_limit_exceeded`);
  }
  return failures;
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}
