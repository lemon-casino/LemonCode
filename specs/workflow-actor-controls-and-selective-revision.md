# Workflow actor controls and selective revision

## Product rules

- A workflow inherits a launch-time snapshot of the parent session's model, reasoning level, and speed. The approval interaction may override these defaults per named actor or concrete fan-out instance. A script's `agent()` configuration may supply defaults, but user-approved overrides win. Unsupported model options are rejected before dispatch; they are never silently dropped.
- The run Configure popover displays the launch-time inherited model, reasoning and speed together, including when "session model" is selected. Reasoning and speed have separate labeled controls below the model picker, so a model menu cannot conceal them. The user can explicitly change model, reasoning and speed; Apply sends a complete structured selection for overrides, or a reset-to-inheritance command. No speed is serialized through the legacy picker string. A setting revision retains the launch-time inherited selection even if the parent session changed meanwhile. Existing runs without a structured launch selection show an unresolved value instead of inventing one.
- An actor is a persistent context; an ask is one task. A task action targets `(runId, ask siteId, ask ordinal, attempt)` and must not affect another ask of the same actor or an unrelated parallel actor. Repeated clicks and stale commands return an explicit result without performing the action twice.
- Stopping a running ask aborts that ask and leaves its result pending user action. Independent parallel asks keep running; consumers of the stopped result wait. The user can rerun the ask or stop the whole run. A stopped ask does not fabricate a typed value.
- Rerunning a live ask creates a new attempt with the original instructions and optional user supplement. Previous attempts and tool transcripts remain readable. Already executed file writes are not rolled back.
- Revising an already consumed or completed result starts immediately. The selected ask, the remainder of its actor context, and all actual data/control dependents are invalidated and rerun. Other asks keep running or their completed results are reused where sound. A UI phase is not a dependency boundary: a dependent in another phase must rerun, while an independent ask in the same phase must not.
- During a live ask a supplement is admitted into that ask at a safe turn boundary. Once the ask has settled, the user chooses either an independent linked actor continuation (does not change the workflow's result) or a workflow revision (recomputes the affected dependents). A completed actor runtime is not assumed to remain alive.
- The task supplement accepts pasted images (and text) with the ordinary composer attachment transaction. Images are uploaded/staged before submission, represented by bounded `AttachmentRef` values in the task command and journal, and delivered as image blocks to the selected actor's next attempt. A completed ask's revision carries the references to its new run; cold resume replays the same references. An upload failure or missing image keeps the draft and does not send a text-only substitute. Unrelated tasks and the main composer do not receive the image.
- Disjoint known file operations may proceed in parallel. Conflicting reads/writes wait at the operation boundary, not for an entire ask or run. Unknown workspace-mutating operations use a workspace-wide conflict scope. An already started operation reaches a safe boundary; cancellation never implies rollback. Conflict policy is enforced by the owner before executing tools, not by a renderer or after-the-fact event observer.
- The workflow runtime alone injects a shared operation admission port into its actors. Exact `Read`, `Edit`, and `Write` paths use normalized file scopes; other unknown reads or workspace-mutating tools use a workspace-wide scope. The lock covers the actual handler lifetime (including cancellation or timeout cleanup), and a queued aborted call never starts the handler. Ordinary sessions are not subject to the workflow lock.
- Run-level Stop/Resume and existing workflows remain compatible. Revised runs preserve lineage, original attempts, per-actor effective configuration and audit records. Cold resume must not silently select a different model or repeat an accepted command.

## Ownership and ordering

```text
actor detail / workflow approval (draft)
  -> v4 command (parent session + run/actor/ask + expected attempt)
  -> CLI DynamicWorkflowRunService admission (sole owner of run and revision)
  -> engine AskScheduler (ask attempts, actor FIFO, dependent gating)
  -> driver (model selection, tool admission, turn cancellation)
  -> journal (commands, attempts, resolved configuration, lineage)
  -> parent workflow progress + actor transcript projections
  -> desktop continuous stream / mobile replayable snapshot and gap repair

Configure: model catalog + run launch selection -> popover draft -> structured override/reset
  -> command validation -> new run launch selection -> journal -> live/replay projection

Image paste: side-pane scoped draft -> attachment upload -> task command refs
  -> owner admission -> journaled ask revision/retry -> child turn image blocks
  -> accepted ACK -> attachment adoption/clear (failure keeps draft)
```

- The UI may display a pending command but never owns an accepted task queue. Scope is `workspaceIdentity?.trim() || workspacePath`, with `workspacePath` retained for execution. Commands route through the existing parent session/Host owner and reject stale run or attempt generations.
- The journal records admission before driver side effects and settles an attempt before resolving its script promise. Restart reconstructs stopped/pending attempts and effective settings from durable facts, not renderer state. Late model/tool results from earlier attempts cannot settle a newer attempt.
- Model override precedence is approved per-instance > approved per-name > script actor default > approved workflow default > session snapshot. The effective model/options are validated against the catalog and recorded for each actor; changing them invalidates the affected actor's cache and causal dependents.
- The parent session owns attachment storage. The actor-task composer only owns unsubmitted text/image refs keyed by run and ask; the run service owns accepted supplements and their attempt generation. An ACK never clears a newer draft, and repeat/stale commands do not append duplicate images. The child driver resolves refs into image model input on the selected attempt; a resumed run uses journaled refs, not renderer state.
- The dependency set is computed from the existing causal graph plus actual actor FIFO/instance bindings and world access. When independence cannot be established, avoid an unsound cache reuse; keep the unaffected running ask alive but defer conflicting tool operations until safe.

## UI

- A graph pill opens one stable actor tab and focuses the ask in that phase. Selecting a different ask of the same actor updates focus rather than opening a duplicate tab.
- The actor tab has a compact task selector and status/actions header (Stop, Rerun, effective model/reasoning/speed), scrollable read-only transcript with preserved attempts, and a bottom supplementary composer. Stop is available only while an ask is live; Rerun is available for live, stopped, failed and completed asks. All controls have accessible labels and tooltips.
- For a completed ask, the composer explicitly distinguishes `Continue this actor` from `Revise workflow and affected tasks`, defaulting to revision when entered from a workflow task. The independent continuation is visibly linked but does not mutate the previous result. A revision offers a before-submit summary of its affected tasks and any already applied file changes.
- Narrow panels keep the composer pinned, collapse secondary actions into a menu, avoid horizontal overflow and do not expose the generic read-only SessionPane's normal send/stop controls. Follow the existing design tokens, i18n and mobile Web safe-area/input conventions.

## Acceptance cases

1. In `Promise.all([A.ask(), B.ask()])`, stopping A aborts only A; B completes. The dependent join waits for A's rerun; Stop Run still cancels both. A second Stop is rejected without another attempt or event.
2. Rerunning a live A cancels its old attempt; a late result from that attempt is ignored. The new attempt receives the chosen model/options and supplement; both transcripts remain accessible.
3. Revising a completed A while an independent B is live starts A's new work immediately, keeps B live once, and reruns only the nodes consuming A (including cross-phase consumers). If B's access conflicts with A's, the conflicting operation waits; no unrelated ask is cancelled.
4. Revising a previously completed run produces linked lineage, retains original artifacts/history and updates affected outputs without importing stale actor or workspace results. Repeated command delivery starts at most one revision.
5. A completed actor can receive a linked independent continuation without changing its run status or results. Selecting revision instead recomputes affected nodes. Unknown or superseded runs receive a structured rejection.
6. A run with no overrides inherits the launch-time model/reasoning/speed even if the parent selection later changes. Two agents may use different models/options; an unavailable model is reported before dispatch. A crash/resume keeps the recorded choices.
7. Desktop live updates and mobile remote replay restore the same attempt statuses, selected run lineage, command rejection and transcript after disconnect. Narrow panel and translated labels fit without hiding the send control.
8. File edits already performed by a cancelled ask remain visible; a rerun does not silently revert them. Conflicting unknown shell writes serialize only their execution, not unrelated model reasoning or whole actors.
9. Configure displays the inherited reasoning and speed when no run override exists, including between run registration and the first durable launch event. Changing either alone produces an explicit, validated structured run override, and reverting returns to the captured launch selection on live and cold replay. Unsupported options fail without stopping the predecessor. Narrow popovers expose all three controls without horizontal clipping.
10. Paste an image and optional text into a selected actor task. The image appears as a removable pending chip, submit waits for upload, and the selected actor receives an image on retry/revision. Switching task scope does not send that image elsewhere; on command rejection, upload error or attachment preparation failure the image remains available and the submit control becomes usable again. Cold resume of an accepted revision retains bounded image refs without duplicating the command.

## Validation

- Engine tests cover FIFO, parallel stop/retry, stale attempt results, selective dependency invalidation, cache and resume.
- Service/protocol tests cover parent-session ownership, duplicate commands, revision lineage, model option validation and replay.
- UI interaction tests cover per-ask focus, action enablement, composer modes, failure/permission handling, narrow widths and keyboard access. Run package tests, `pnpm typecheck`, `pnpm lint`, and `pnpm architecture:check --changed` after implementation.
