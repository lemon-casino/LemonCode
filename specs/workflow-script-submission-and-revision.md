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

## Validation

- Contract and resolver tests cover source exclusivity, ordered replacements, missing and ambiguous
  matches, no-op batches and stored-script resolution.
- Run CLI package type checks and targeted tests, then repository `pnpm typecheck`, `pnpm lint` and
  `pnpm architecture:check --changed`.
