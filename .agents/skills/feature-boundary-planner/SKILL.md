---
name: feature-boundary-planner
description: Map a LCode behavior change to current UI surfaces, state owners, protocol commands, persistence, and validation. Use for impact analysis, product-boundary planning, or an implementation handoff grounded in the checked-out source.
---

# Feature Boundary Planner

Trace the requested behavior through the current checkout. A feature belongs in the result only when current source or an explicit new requirement supports it. Verify referenced paths and symbols before using them; do not reconstruct removed functionality from historical catalogs.

## Choose The Scope

- **impact-only:** inspect and report without changing code or product specs.
- **planning:** establish behavior and acceptance cases before implementation.
- **implementation-handoff:** turn confirmed decisions into a bounded implementation and validation plan.

Use the mode implied by the request. Clarify only unknown decisions that materially change the scope; do not ask the user to reconfirm facts already established in this task.

## Find Current Evidence

1. Search aliases and node IDs in [lcode-feature-graph.yaml](references/lcode-feature-graph.yaml) for the user's terms. Read only matched nodes and their one-hop relationships, then verify the declared files, symbols and semantics against the current checkout. The graph is a curated seed index, not a complete feature inventory. Use [source-discovery.md](references/source-discovery.md) to fill gaps or start when there is no match. Read the relevant existing contracts and package scripts; read `DESIGN.md` for UI work and `CONTEXT.md` for plugin-store work.
2. Locate the entrypoint with `rg --files` and focused `rg -n` searches. Trace direct callers with `pnpm dep:refs <file>:<symbol>` when the symbol is a TypeScript export. If an indexed codegraph tool is available, use it as additional evidence and verify its paths against the checkout.
3. Classify the change: presentation, option source, draft/default, validation, commit effect, persistence, or recovery.
4. Trace each user surface separately through validation and the command that commits the change. Shared UI components do not establish shared state or side effects.
5. Identify the authoritative owner, derived views, protocol boundary, persistence and failure behavior. Name the semantic reason for each upstream or downstream dependency; imports alone do not prove a product relationship.
6. Inspect one meaningful semantic hop first, expanding only when an unresolved owner or caller requires it. Rank relationships as must-inspect, should-inspect, conditional, invariant-only, or evidence-only.

For stateful or asynchronous behavior, show a concise diagram:

```text
user action → surface draft → validation → owner command → event / persistence
                                                └── derived UI projection
```

## Maintain The Seed Graph

Keep existing node IDs for unchanged semantic boundaries and add aliases for new terminology. Report missing seeds or changed relationships as `graph-drift-candidate`; static reachability alone does not establish a product dependency.

In `impact-only` mode, report proposed graph changes without editing files. In planning or implementation, update only verified entries within the task's scope. Follow the [graph contract](../../../docs/skills/feature-boundary-graph.md): check YAML parsing, unique IDs, relationship endpoints and ranks, and tracked source paths and symbols. Do not restore missing historical docs or claim test coverage from a graph entry.

## Plan And Prune

In planning modes, write or update a feature spec before implementation. Create the spec directory if needed; do not assume an existing case catalog, test runner, or coverage workflow.

Select only dimensions that can change behavior: state, event, target, client mode, delivery kind, workspace identity, runtime availability and persistence source. Prefer representative and high-risk combinations over a global Cartesian product.

Classify cases as accepted, undefined, pruned, ignored, or bug-candidate. Give every pruned case an invariant or guard; leave undefined behavior as a concrete decision. Record accepted cases with setup, action, assertions and required evidence using [case-planning-template.md](references/case-planning-template.md).

Before handing off validation, check which tests, fixtures and commands actually exist in the target package. Distinguish planned tests, executed tests and admitted regression coverage. A missing test path is a gap, not coverage.

## Output

Use [impact-brief-template.md](references/impact-brief-template.md) for the relevant parts of the result:

- behavior summary and scope;
- UI surface matrix, shared implementation and divergent behavior;
- ranked dependencies with current file/symbol evidence;
- state owners, validation points, commit commands and persistence;
- invariants and representative validation cases;
- unresolved decisions, unavailable evidence and relevant graph drift or updates.

## Boundaries

- Preserve `workspaceIdentity?.trim() || workspacePath` for isolation and `workspacePath` for execution/display.
- Keep desktop `desktop-continuous` delivery separate from mobile `web-remote-replayable` recovery.
- Trace accepted commands to their authoritative owner; do not turn a client draft or optimistic overlay into another accepted queue.
- Treat runtime state, snapshots, indexes, settings and caches as distinct until their synchronization is proven.
- Do not infer current functionality from a directory left behind by build artifacts, an old document, or a historical branch.
- Do not silently change product semantics to match an implementation discrepancy; report the evidence and the decision needed.
