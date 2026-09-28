# Current Source Discovery

Paths below are repository-relative starting points, not a feature inventory. Confirm each path exists and contains tracked source before using it. Discover exact symbols and callers from the current checkout.

Use [lcode-feature-graph.yaml](lcode-feature-graph.yaml) for known capability aliases, UI surfaces, owners and ranked relationships. Search first rather than loading the whole graph:

```sh
rg -n '模型选择|消息队列|工作区隔离|输入框触发器' .agents/skills/feature-boundary-planner/references/lcode-feature-graph.yaml
```

Read the matching node and relationships referencing its ID, then inspect the declared source. Missing graph coverage is a reason to use the source entrypoints below, not evidence that a feature is absent. File and symbol presence validates a retrieval seed, not its behavior or test coverage.

| Concern               | Starting points                           | Evidence to trace                                                    |
| --------------------- | ----------------------------------------- | -------------------------------------------------------------------- |
| UI and state          | `packages/ui/src`, `DESIGN.md`            | entrypoint, draft owner, shared callers, validation, commit action   |
| Business services     | `packages/services/src`                   | authoritative owner, command admission, public contract, persistence |
| Shared contracts      | `packages/shared/src`, `packages/rpc/src` | runtime schema, request/event shape, routing boundary                |
| Desktop lifecycle     | `packages/desktop/src`                    | renderer/host/main responsibilities, process ownership               |
| Web client and server | `packages/web/src`, `packages/server/src` | transport, authentication, attachment, client mode                   |
| Agent runtime         | `apps/lcode-cli/packages`                 | command handler, runtime state, emitted events                       |
| Module boundaries     | `architecture-policy.yaml`                | declared roots, layers, public entrypoints, dependencies             |

Start with bounded searches in the relevant area:

```sh
rg --files packages/ui/src packages/services/src packages/shared/src
rg -n 'clientMode|deliveryKind|workspaceIdentity' packages/shared/src
```

Choose search terms from the user's behavior and the discovered source. Inspect `package.json` in the relevant package before invoking development or test commands. An unavailable tool or runner must be reported as unavailable rather than replaced with an invented command.

For each stateful path, record:

| Question                                          | Evidence                                               |
| ------------------------------------------------- | ------------------------------------------------------ |
| Who accepts the write?                            | command handler and owning service/runtime             |
| Which surfaces read it?                           | callers, hook/store subscriptions and projections      |
| What persists?                                    | repository/schema and actual write/read paths          |
| What happens after reconnect or stale completion? | sequence/identity guards and recovery handlers         |
| What proves the behavior?                         | executed test or observed runtime path with assertions |

For affected existing tests, preserve their case identity and distinguish test existence from a successful run. For new cases, specify setup, action, assertions, environment and required evidence before choosing a runner.
