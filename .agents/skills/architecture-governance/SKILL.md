---
name: architecture-governance
description: Apply the repository's architecture policy to code changes by generating a bounded context package, checking module and layer boundaries, and reporting baseline-aware violations. Use for any code change; skip for documentation-only work.
---

# Architecture governance

Use this skill before editing code in the LCode repository. It is a design guide as well as a gate: the goal is to make the intended architecture obvious before code is generated, so the checker confirms a decision instead of discovering it for the first time.

## Before writing code

1. Identify changed files and their modules with `pnpm architecture:check --changed`.
2. Run `pnpm architecture:context <module-id>` (or the reusable wrapper `node .agents/skills/architecture-governance/scripts/context-package.mjs <module-id>`). Read the target contract, directly referenced contracts, and any existing relevant spec and tests before opening broad implementation files. Do not assume a documentation or test path exists; verify it in the checkout.
3. Write or update the spec before implementation; create its directory when needed. State the behavior, ownership, invariants, failure semantics, and migration boundary in the spec.
4. Make a short design decision before coding:
   - **One owner:** name the single component that owns each piece of mutable state. Other layers read through its contract and send commands; they do not keep a second accepted queue, cache, or derived truth.
   - **One path:** reuse an existing command, service, hook, adapter, or contract when it already expresses the behavior. Do not create a parallel helper for the same responsibility.
   - **Explicit boundaries:** choose the layer for every new file and the public contract for every cross-module edge. Use the module's declared `layers` and `layerOrder`; a file may import only its own layer or lower ones through their public surface. `domain` is pure (no IO, no `await` on the world), `app` decides side effects through ports, `adapters` executes them, `ui` depends only on this module's `contract.ts`. Quick test: needs `await`? not domain. Knows it is sqlite / MessagePort / a timer? adapters.
   - **Explicit time:** for asynchronous or remote behavior, write the event order, owner/lease, idempotency key, stale-result rule, replay/resume boundary, and desktop versus mobile delivery kind before implementation.
   - **Bounded context:** prefer the generated reading package over copying whole implementations into the prompt. Read more only when a contract or test proves it is necessary.
5. If the change crosses modules or changes state ownership, include the decision in the spec and add or update the module contract before implementation.

Use this compact design sketch while planning stateful changes:

```text
input → single owner → command admission → state transition → contract/event
                  └── persistence / replay / projection are derived from the owner
```

For remote or streaming changes, make the delivery boundary explicit:

```text
desktop: continuous ── direct live stream ──┐
                                           ├─ same owner and sequence
mobile: replayable ─ snapshot + gap repair ┘
```

## During and after editing

6. Keep changes inside the declared module and its allowed layer direction. Add a module dependency or public contract before introducing a cross-module edge.
7. Run `pnpm architecture:check --changed` again after editing. Report new violations separately from baseline violations, along with changed modules, tests, state owners, event-order assumptions, and net line changes.

The executable policy is `architecture-policy.yaml`; do not duplicate its rules in this file or in AGENTS.md. Use `pnpm architecture:baseline:update` only when a reviewed change intentionally changes the accepted legacy baseline. CI never refreshes baseline automatically.

When adding source, identify its owning module. If a new managed module is required, register its roots, dependencies, layers and public entrypoints in `architecture-policy.yaml`, and keep the local manifest consistent with that policy. Use the existing managed modules and the fixture below as examples.

For a new managed module, provide `module.ts`, `contract.ts`, `contract.example.ts`, and a short `CONTRACT.md`. Keep runtime and persistence details behind the contract. Prefer typed service calls for one-to-one interactions, commands for state changes, and typed events for broadcast facts.

See [policy-schema.md](references/policy-schema.md), [module-contract.md](references/module-contract.md), and [rule-catalog.md](references/rule-catalog.md) when the change needs their detailed guidance. The [golden-module](references/golden-module) fixture is the smallest compliant example.
See [ai-guidance.md](references/ai-guidance.md) for the anti-patterns this workflow is designed to prevent and the questions an agent must answer before proposing code.
