# Workflow script submission and revision efficiency

## Goals

Reduce the model tokens and tool round trips needed to create and revise a dynamic workflow without
introducing an opaque script format or a second script owner.

## Product rules

1. A new `CreateWorkflow` run still receives one complete, readable TypeScript script. The runtime
   persists that exact script as the authoritative run input; compression, encoded payloads and
   implicit script generation are out of scope.
2. Tool descriptions contain the facade and the minimum rules required to submit a correct script.
   Detailed examples, rationale and repair guidance belong to the on-demand `dynamic-workflows`
   skill rather than the always-present tool contract.
3. `AmendWorkflow` accepts one of three revised-script sources: `edits`, `path` or `script`. They are
   mutually exclusive. Omitting all three keeps the predecessor script and changes only settings.
4. `edits` is the preferred source when the changed fragments are already in context. It is an
   ordered list of exact `{ find, replace }` operations applied to the predecessor's stored script.
   Each `find` must be non-empty and occur exactly once at the point where its edit is applied.
5. The edit batch is atomic. A missing or ambiguous fragment, unavailable predecessor script, or a
   batch whose final bytes equal the predecessor fails before approval, before stopping a live run,
   and before creating or writing a replacement run.
6. A successful edit batch is compiled and approved as the resulting complete script. The handler
   writes that complete script to a new workflow draft and records the draft on the amended run. It
   does not mutate the predecessor's script file.
7. `path` remains the reliable fallback when the model no longer has the changed source fragment in
   context. Full inline `script` remains available for a genuine rewrite.
8. Existing cache semantics are unchanged: stable actor names and byte-identical asks reuse settled
   predecessor work. Script edits do not bypass compilation, permission, lineage, owner/lease or
   stale-run safeguards.

## Bounded asks and real dependencies (P0)

Every non-trivial ask has one independently acceptable deliverable, the relevant input paths,
allowed and excluded scope, and a stop condition. Investigation, an interface decision,
implementation and final whole-project acceptance are separate deliveries, not an open-ended
"freeze everything" ask. Return only the conclusion, evidence paths, downstream contract and
remaining blockers; missing evidence is a blocker, never a guessed implementation. Preserve all
safety invariants in the slice's acceptance criteria.

Start independent read-only investigations on separate actors before awaiting either result.
Creating an actor does not enqueue an ask. Reuse the same domain actor for follow-up work;
its asks remain FIFO, not parallel. Shared spec/contract files have one writer. Implementations
that require the agreed contract must wait for it, while unrelated investigations need not.
Baseline checks complete before mutation; branch checks run when that branch is ready; final
integration checks wait for all relevant writes and verify the final code. The script runs a
whole-project check once instead of asking every actor to repeat it. Do not reduce safety review,
change concurrency settings, or create unnecessary actors to satisfy this guidance.

The always-present CreateWorkflow description keeps only the short objective/scope/stop and
dependency rules within its existing 15,000-character budget. The built-in dynamic-workflows
skill owns the detailed counterexample and executable positive example. Plugin source is the
maintenance entry; installed user plugin caches are not edited or assumed to be updated.

## Explicit acceptance evidence

Choose bounded root execution for small tasks, serial slices for actual shared-state dependencies,
and parallel lanes only where independence is established. The final integrated check waits for
relevant actor writes to settle. An actor's local pass or a cached `world.run` result is historical
evidence; it does not prove the current integrated bytes. Goal strict acceptance may bind explicit
requirements to live `world.run` executable/argv and file digests through the driver's optional
evidence owner. This observation never changes the script, command approval, actor scheduling,
admission, run settlement or existing world replay. An unsettled actor makes final evidence unknown.

## Non-blocking orchestration advice (P2)

`analyzeWorkflowScript` derives optional advice from the existing analysis core and control/order
facts, separately from `diagnostics`. Advice never changes `ok`, compilation, admission, actor
FIFO, permission, concurrency, model choice, script bytes or execution order. No additional model
call or second TypeScript interpretation is introduced.

The first release deliberately recognizes only straight-line, reliably located candidates:

- A direct non-optional ask await precedes the issue of at least two calls on other, statically
  known actors before the next barrier; the later calls have no known result input.
- A directly awaited full tuple join of direct non-optional asks precedes an ask whose exact,
  indexed input comes from only a proper subset of those branches. It may be worth checking a
  per-branch continuation.

The source location identifies the actual await, not an inferred duration. `waitingOn` and
`delayed` locate the known producer/call sites. Wording reports control waiting and asks the
author to check whether independent work can start earlier; absence of a data edge never proves
absence of file, permission, actor-context or external-effect dependencies. Unknown/may-set
receivers, uncertain barriers, optional calls, race/other combinators, unreachable suffixes,
branches, loops, helper/strand boundaries and unlocated old cores are omitted. Same-actor work and full-data joins are not parallelization candidates. Legal safe
serialization stays legal; there is no automatic fix or speedup claim.

The bounded transport contract is:

```ts
interface WorkflowOrchestrationAdvice {
  code: "await-before-later-asks" | "join-before-per-item-work";
  line: number; // 1-based script-body await location
  column: number;
  waitingOn: { line: number; column: number }[];
  delayed: { line: number; column: number }[];
  message: string;
}
// Host-only normalized Create/Amend input, not an authored tool argument:
// orchestration_advice?: { scriptHash: string; items: WorkflowOrchestrationAdvice[] }
// Create/Amend output: orchestrationAdvice?: WorkflowOrchestrationAdvice[]
```

At most five advice items and eight source locations per group cross the tool boundary; messages
are limited to 1,024 characters. No candidate means the optional transport fields are absent.
Resolvers discard model-supplied advice before recomputing from the resolved script. Confirmation
reads the existing raw-input channel, whose clients tolerate extra fields, and shows advice only
when `scriptHash` matches the current script using the shared browser-safe
`workflowScriptFingerprint` helper. `readWorkflowOrchestrationAdvice` is the common bounded
validator and stale-advice reader; its non-cryptographic fingerprint is not an authorization
credential. The analysis package stays independent of shared. CLI Zod v3 mirrors the small
shared Zod v4 boundary using the same codes/limits, with parity tests. This suppresses stale
advice if a hook or approval edit changes the script. Handler output is
always recomputed from the execution script; text responses use file-line offsets when a metadata
header exists. The frozen `create_workflow` display schema is unchanged, so old strict desktop
and mobile readers retain their graphs and diagnostics. Older clients may omit the new advice.

```text
resolved script -> existing memoized analysis -> bounded advice + script hash -> approval raw
                -> hook / approval script edit -> hash mismatch: omit stale advice
approved script -> existing analysis -> tool response advice + unchanged submit/amend path
```

Advice is a derived submission-time read model, not persisted run state or a scheduling owner.

## State owner and interface

`DynamicWorkflowRunService` and its journal remain the only owners of run scripts and lineage.
`AmendWorkflow.edits` is a command payload, not persisted patch state. The tool resolver reads the
predecessor script once through `DynamicWorkflowRunPort.getScript`, creates an in-memory candidate,
and passes the complete candidate through the existing compile, approval and `port.amend` path.

```text
run_id + edits
  -> AmendWorkflow resolver
  -> read immutable predecessor script from DynamicWorkflowRunPort
  -> apply ordered exact edits in memory
     -> conflict: reject atomically, no approval/write/stop
  -> existing compile and approval path
  -> write complete candidate draft
  -> DynamicWorkflowRunService.amend (stop/import/start/journal)
  -> existing desktop continuous and mobile replayable projections
```

The normalized execution input contains the resolved full `script`, not `edits`. Hooks, approval and
the handler therefore inspect the same bytes that will run, while the model-originated tool call stays
compact.

## Failure semantics

- More than one of `edits`, `path` and `script`: source validation failure.
- No stored predecessor script for `edits`: `workflow_amend_script_unavailable`.
- `find` occurs zero times: `workflow_script_edit_missing` with the one-based edit index.
- `find` occurs more than once: `workflow_script_edit_ambiguous` with the match count; the caller must
  provide a larger unique fragment or use `path`.
- The ordered batch produces no byte change: `workflow_script_unchanged`.
- Compilation failure writes the complete candidate draft for repair but does not touch the predecessor
  run, matching existing inline amendment behavior.

## Acceptance scenarios

1. A one-line change can be submitted as one `AmendWorkflow` call containing `run_id` and one small
   edit; no separate `Edit` tool call and no complete script retransmission are required.
2. Multiple independent edits apply in order and launch one amended run whose stored script is their
   complete result.
3. If any edit is missing or ambiguous, none of the edits is committed and a running predecessor is
   not stopped.
4. Supplying `edits` with `path` or `script` is rejected before hooks and approval.
5. A settings-only amendment with no script source still inherits the predecessor script unchanged.
6. A model that lacks the old fragment can still edit the reported draft and submit `path` exactly as
   before.
7. Create and amend tool descriptions keep lifecycle and safety rules but avoid duplicating long-form
   guidance already supplied by the dynamic-workflows skill.
8. Execute the built-in bounded-delivery example with a controlled driver: independent UI investigation
   is queued before the delayed service result, including when one admission slot serializes actual
   starts. The single contract writer and dependent implementation do not start before their inputs;
   a blocked contract does not enqueue either dependent implementation. This tests execution, not just
   prompt keywords. A same-actor FIFO regression keeps context-dependent asks serialized.
9. Advice-positive scripts still compile with zero diagnostics and follow the same approval/submit
   path. Locations point to the await and actual producer/delayed calls. Parallel work, full-data
   joins, same-actor FIFO, safety branches, helper/loop uncertainty and missing source locations
   produce no advice. No script is rewritten and no extra model call runs.
10. Both Create and Amend expose bounded host-derived advice in confirmation raw and tool output,
    reject forged advice as an authority, and omit stale confirmation advice on script hash mismatch.
    Plain, metadata-header and revised scripts keep body/file line numbers consistent. Existing
    display schema and permission ownership rules are unchanged.

## Validation

- Contract and resolver tests cover source exclusivity, ordered replacements, missing and ambiguous
  matches, no-op batches and stored-script resolution.
- Run CLI package type checks and targeted tests, then repository `pnpm typecheck`, `pnpm lint` and
  `pnpm architecture:check --changed`.
