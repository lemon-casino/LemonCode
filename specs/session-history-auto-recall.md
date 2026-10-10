# Opt-in turn-start session history recall

## Behavior

`sessionRecall.enabled` enables an experimental, read-only prior-session recall step before the first
model request of an eligible real-user turn. It is `false` by default and is independent from both
`features.memory` and `memory.use`; disabling Project Memory must not silently disable an explicitly
enabled session recall, and enabling Project Memory must not enable session recall.

Headless CLI runs follow the existing JSON configuration precedence documented in the CLI README:

```json
{
  "sessionRecall": {
    "enabled": false
  }
}
```

App-created sessions use the persisted `AppSettings.sessionRecallEnabled` preference exposed under
Settings → Memory as “Automatic history recall”. The preference defaults to `false`, is written only
through the existing Setting service, and is carried through the existing
`session/requestRuntimePreferences` request. For an app-created session, that Host response is the
authoritative enable value and may explicitly enable or disable the runtime setting. Existing Hosts that
omit the additive field are parsed as `false`; headless CLI runs continue to use `sessionRecall.enabled`.
There is no UI-local mirror, database column, environment variable, or inferred rollout flag.

The onboarding preferences page is a second entry point for the same `AppSettings` field, placed next to
“Enable Workspace Memory”. It is a plain checkbox with no help trigger, and it keeps the same independence:
toggling workspace memory does not toggle it. It shows the current effective value, so the wizard cannot
silently disable recall that was enabled in Settings; the field is written only when the user actually
changes the checkbox, and the skip path writes nothing. The existing Setting service write is sufficient —
the Host re-reads the preference at session materialization, so no extra runtime-preferences sync is needed.

The setting row includes a keyboard-focusable `?` help trigger. Hover or focus explains that recall
searches only prior sessions from the same workspace, supplies bounded read-only context to the Agent,
does not modify prior history, and applies to newly materialized sessions rather than an already-running
runtime.

## Ownership and interfaces

- Persisted session truth remains owned by `SessionStorePort`.
- Workspace isolation, active-branch projection, lexical ranking, and failure discrimination are shared
  with explicit `SessionHistorySearch`; automatic recall must not fork those rules.
- The app preference is owned by `AppSettings`/the Setting service. The Host projects it through the
  runtime-preferences contract; the CLI runtime configuration owns the materialized per-session value.
  Headless CLI configuration remains owned by the scoped runtime configuration system.
- The current turn's `TurnRequestState` owns the derived `session_recall` attachment. It is never
  appended to canonical `MessageHistory`, session events, compact summaries, or cold-resume history.
- `AgentRuntime` performs orchestration through the shared core search service; no tool call/result is
  forged and no automatic `ReadSessionContext` deep read occurs.

```text
persisted sessions ── bounded shared search ──┐
                                             ├─ TurnRequestState session_recall overlay
real visible user query ─────────────────────┘

canonical MessageHistory / SessionStore  ← never written by recall
```

```text
Settings switch / onboarding checkbox → Setting service/AppSettings
                                       → Host runtime-preferences response
                                       → session runtime config snapshot
                                       → eligible turn-start recall
```

Saving the setting does not mutate an already materialized runtime. A newly created or cold-restored
session reads the current preference. A fork/child that deliberately inherits its parent runtime
preferences keeps the parent snapshot so one runtime tree cannot change semantics mid-flight.

## Eligibility and event order

Recall is attempted only when all conditions hold:

- `sessionRecall.enabled === true`;
- the current task type is `interactive`, `fork`, or `workflow_parent` (missing legacy task type is
  treated as `interactive`);
- the turn began from a non-empty, real, visible user input that will be persisted;
- this is the first model step and not output-token continuation;
- the runtime has a `SessionStorePort`.

Model-only continuations, already-persisted resume input, synthetic/background input, automations,
off-peak jobs, workflow children, selection side chats, and subagent children do not auto-recall.
Cold resume without a new query never guesses from titles.

```text
persist real user input
  → establish TurnRequestState
  → micro/auto compact
  → optional Project Memory recall
  → opt-in session history recall (once per turn)
  → initialize remaining request dependencies
  → first provider request
```

The attempt bit is set before storage I/O. Provider failover and later tool/model steps reuse the same
overlay and cannot repeat the search. Micro/auto/reactive compact temporarily detaches both Project
Memory and session-history recall overlays, then restores them in `finally`.

## Isolation, ranking, and automatic budgets

Automatic recall uses the same identity-first matrix, candidate task types, current-session exclusion,
metadata refresh, rewind branch selection, searchable text projection, deterministic lexical ranking,
and no-positive-score behavior as `SessionHistorySearch`.

It applies stricter bounds than the explicit tool:

- candidate sessions: at most 8, with bounded lookahead for exclusion/truncation;
- per-session searchable projection: at most 12,000 UTF-16 characters;
- total searchable projection: at most 64,000 UTF-16 characters;
- returned matches: at most 3;
- title: at most 256 characters;
- preview: at most 600 characters per match;
- provider-visible attachment: at most 3,200 characters after sanitization.

Only positive lexical matches are attached. An empty or unavailable search adds no attachment. Returned
titles/previews are labelled untrusted background facts and cannot be interpreted as instructions.
The model may explicitly call `ReadSessionContext` for detail; automatic recall never does so.

The production SQLite store additionally caps each candidate snapshot at 96 message rows, 384 part rows,
and 98,304 persisted JSON data bytes. These are storage payload bounds, not claims about SQLite page I/O
or decoded-object heap. Legacy stores may omit the optional snapshot capability and retain the established
`messages + getSession` fallback. No `Promise.race` claims to cancel synchronous SQLite work.

## Failure, cancellation, and observation

Storage unavailability, list failure, per-session failure, formatter failure, or no lexical match is a
best-effort miss and cannot fail the main turn. Cancellation is checked between reads; after the helper
returns, the normal turn abort check remains authoritative.

Completion logs only duration and bounded count/character/truncation fields. Failure logs only a stable
reason or error class. Queries, titles, previews, session IDs, workspace identity, paths, and raw storage
errors are never logged.

The engineering rollout gate requires representative offline evidence satisfying both:

- precision@3 at least 0.80 and false-positive-query rate at most 0.10 on a reviewed multilingual fixture;
- added pre-request latency p95 at most 150 ms and p99 at most 300 ms on the agreed bounded corpus.

The checked-out implementation satisfies both gates; the accepted environment and latency report are
recorded in `docs/benchmarks/session-history-recall-2026-09-27.md`. Runtime telemetry records duration for
later aggregation but does not enforce a misleading timeout around synchronous storage. The feature
remains manual opt-in because default-on is a separate product decision, not an automatic consequence of
passing the engineering gate. The reproducible corpus is defined in
`specs/session-history-recall-benchmark.md`; passing it prunes P4.

## Acceptance cases

| ID     | Setup / action                                              | Assertions                                                                    |
| ------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| SAR-1  | Setting absent or `false`                                   | No session-store read and no attachment                                       |
| SAR-2  | Setting `true`, Project Memory disabled                     | Session recall still runs; the two switches are independent                   |
| SAR-3  | Real user query has a same-workspace positive match         | One `session_recall` overlay, bounded and labelled untrusted                  |
| SAR-4  | Remote A and same-path remote B                             | Only exact A is read; current session and B are excluded                      |
| SAR-5  | No positive match or search unavailable                     | No overlay; main turn continues                                               |
| SAR-6  | Tool step / provider failover after first request           | Search is not repeated; the same overlay remains available                    |
| SAR-7  | Compact before or during the turn                           | Recall overlays are excluded from summary/persistence and restored afterward  |
| SAR-8  | Model-only, resume, automation, off-peak, or child runtime  | No automatic search                                                           |
| SAR-9  | Adversarial title/preview contains reminder markup          | Markup is sanitized and attachment stays within 3,200 characters              |
| SAR-10 | Multilingual offline ranking fixture                        | Precision/false-positive thresholds are computed deterministically            |
| SAR-11 | SQLite bounded snapshot capability                          | Automatic path sends the stricter row/byte limits and propagates truncation   |
| SAR-12 | Reproducible production-SQLite benchmark                    | Quality and latency gates are recorded without reading a user database        |
| SAR-13 | App setting absent or an old Host omits the protocol field  | UI and protocol both resolve to disabled                                      |
| SAR-14 | User enables the Memory-page switch, then creates a session | Setting persists; the new runtime receives `sessionRecall.enabled = true`     |
| SAR-15 | User toggles the setting while a session is already running | Active runtime is unchanged; the next materialized session uses the new value |
| SAR-16 | Pointer hovers or keyboard focuses the `?` trigger          | Localized help text explains purpose, scope, read-only behavior, and timing   |
| SAR-17 | Onboarding preferences page opened with recall enabled in Settings | The checkbox shows checked; saving without touching it writes no `sessionRecallEnabled` |
| SAR-18 | User checks the onboarding checkbox, then completes onboarding | Settings → Memory reads back enabled; skipping that page writes nothing and leaves the prior value |

### UI interaction scenario

1. Open Settings → Memory with automatic history recall disabled.
2. Hover the `?` control, then reach it again using the keyboard.
3. Verify both paths expose the same localized explanation and the switch remains independently
   operable.
4. Enable the switch, leave and reopen Settings, and verify it remains enabled.
5. Create a new session and verify the Host runtime-preferences response materializes
   `sessionRecall.enabled = true`; confirm an already-running session keeps its original snapshot.

## Migration and rollback

There is no database migration. The protocol change is an additive boolean with a `false` compatibility
default. Rollback is setting `AppSettings.sessionRecallEnabled`/`sessionRecall.enabled` to `false` or
removing the runtime call and reminder source. Persisted session history is unchanged.

## Out of scope

- Default-on or automatic staged rollout.
- Embeddings, vector search, FTS, or database migration.
- Applying bounded snapshots outside history search/automatic recall.
- Automatic deep reads, citations, dedicated recalled-result rendering, or a second recall cache.
