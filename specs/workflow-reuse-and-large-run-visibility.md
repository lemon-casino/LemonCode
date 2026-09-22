# Workflow reuse and large-run visibility

## Product rules

- An amended workflow is a new run. Its journal is authoritative; imported predecessor results are an optimization and must match the same operation, occurrence and actor prefix. Cold restart of that run rebuilds the same import table, replays its own journal while advancing the corresponding import occurrence cursors, then consults the table for new work.
- Each predecessor world operation consumes one occurrence, including failed and interrupted attempts. Only a completed occurrence may supply a cached result. Never substitute a later successful occurrence for an earlier unsuccessful one. A live write closes world-result imports; pure actor asks can continue to use their validated prefix.
- A selective task revision invalidates the selected instance and causally affected work while independent, already completed actors remain eligible for reuse. Replaying a stopped task does not silently restart it.
- Live status in a large workflow must retain the same observed/settled counts, running phases, loop rounds, current-phase fallback and parallel branch ink as the small view. The display graph is bounded to 32 stages, but runtime nodes can fill all 256 slots: on overflow retain active nodes first and admit newer events by evicting an older settled node. Mark the projection as truncated; counts from the retained window must not imply completeness.

## Owners and sequence

```text
predecessor journal --read--> bootstrap import builder (per-occurrence slots)
                                     | new run / cold restart rebuild
                                     v
current run journal --> engine replay --> import cursor --> live driver on misses
                          |                                 | first write
                          +------------ events <------------+ closes import gate
                                         |
                                         v
                        run projection (active-first bounded window)
                                         |
                                         v
                        UI site/actor index --> live stage timeline
```

- Bootstrap owns import construction, the engine owns consumption and journal-first replay, the projection owns runtime facts, and UI selectors own stage indexing and viewport rendering. No UI-local status becomes a runtime fact.
- The desktop continuous view and mobile replayable view both derive from the same projected run state; scroll/viewport state remains local and must not affect replay or persist as a run event.

## Acceptance

1. A failed or interrupted first occurrence followed by completed identical world reads is not reused for the first occurrence; the next occurrences may still reuse the completed records. After cold reconstruction, replaying recorded reads consumes their import positions so the next new read gets the next predecessor occurrence.
2. A completed world run is not executed a second time when safely imported, and a live world run closes imports before writing.
3. Many phases and nodes update observed/settled counts and active phase without repeatedly scanning every run node for every phase or participant. When the bounded node list fills, a new running node replaces an older settled node and continues to receive progress/settlement updates; the run reports truncation and its detail view notes that stage counts may be incomplete. Existing live nodes keep their identities.
4. UI rendering and import changes have focused tests, typecheck and lint; desktop and mobile responsive views retain access to currently running stages.
