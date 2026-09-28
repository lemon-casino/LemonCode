# Session history recall latency gate

## Purpose and decision

The benchmark closes the remaining engineering gate for opt-in turn-start session recall. It measures
the production SQLite bounded-snapshot and shared search path. It does not benchmark a mock store, alter
runtime state, or write to a user's real session database.

Passing the gate means the bounded scan is sufficient and P4 FTS is pruned. Failing the gate permits a
separate reviewed FTS migration design; it does not silently create an index. Passing is also not a
default-on rollout command: `sessionRecall.enabled` remains `false` unless a separate product decision
changes that contract.

## Owner and command

- Persisted benchmark corpus: temporary SQLite database owned by the existing `SqliteSessionStore` and
  deleted in `finally`.
- Search behavior: public `@lcode/core/session-history-search` entry, reusing
  `searchSessionHistory` and `SESSION_HISTORY_AUTO_RECALL_BOUNDS`.
- Measurement and decision:
  `apps/lcode-cli/packages/bootstrap/scripts/session-recall-benchmark.mjs`. Bootstrap is the existing
  integration package that publicly depends on contracts, adapters, and core.
- Reproducible command: `pnpm --dir apps/lcode-cli bench:session-recall` from the repository root.

The command builds the three public package boundaries it imports, prints a single JSON report, and exits
non-zero when a latency threshold or output invariant fails. It never reads the user's configured DB.

## Representative bounded corpus

The default corpus is fixed rather than environment-derived:

- one current interactive session plus nine prior interactive sessions in the same local workspace;
- 64 user messages per prior session and two text parts per message;
- deterministic mixed Chinese, Latin, camelCase, snake_case, and path-like text;
- five deterministic queries rotated across measurements;
- automatic recall bounds: eight candidates, 96 messages, 384 parts, 98,304 persisted JSON bytes per
  candidate, 12,000 projected characters per session, 64,000 total projected characters, three results;
- 25 warm-up runs followed by 200 measured runs.

The first post-seed call is reported separately as `coldMs`. The p95/p99 gate uses warmed calls because
the runtime opens the session store before turn admission. The report includes Node version, platform,
architecture, corpus shape, sample count, thresholds, min/mean/p50/p95/p99/max, and invariant failures;
it contains no user/session text or real paths.

Percentiles use nearest rank over ascending durations: `ceil(p * N) - 1`, clamped to the sample range.

## Thresholds and invariants

The benchmark passes only when all conditions hold:

- p95 is at most 150 ms;
- p99 is at most 300 ms;
- every measured call returns `status: ok`;
- at least one match is returned;
- candidate/scanned/projected/result counts remain within automatic recall bounds.

One machine report is durable evidence for the checked-out implementation and environment, not a
universal performance guarantee. Runtime duration telemetry remains the production regression signal.
The accepted 2026-09-27 Windows x64 report is recorded in
`docs/benchmarks/session-history-recall-2026-09-27.md`.

## Event order

```text
create temporary DB
  -> run existing migrations
  -> seed fixed sessions/messages/parts through SessionStorePort
  -> first cold search (reported, not gated)
  -> 25 warm-up searches
  -> 200 timed production-path searches
  -> summarize + enforce thresholds/invariants
  -> close store and delete temporary DB
```

## Acceptance cases

| ID     | Setup/action                                  | Assertions                                                        |
| ------ | --------------------------------------------- | ----------------------------------------------------------------- |
| SRB-01 | Run default benchmark command                 | Uses production SQLite and automatic bounds; no user DB is opened |
| SRB-02 | Known duration vector                         | Nearest-rank p50/p95/p99 are deterministic                        |
| SRB-03 | p95 or p99 exceeds threshold                  | Report says `passed:false` and process exits non-zero             |
| SRB-04 | Search returns unavailable/empty/out-of-bound | Invariant failure is reported and process exits non-zero          |
| SRB-05 | Thresholds and invariants pass                | Report says `passed:true`; P4 is recorded as pruned               |
| SRB-06 | Seeding, measurement, or assertion throws     | Temporary store closes and directory cleanup still runs           |

## Migration and rollback

There is no database migration or runtime behavior change. Rollback removes the benchmark command,
public benchmark entrypoint, and evidence document. The default recall setting is unchanged.
