# FileSystemPort bounded directory listing

## Behavior

`FileSystemPort.listDirectory` accepts an optional positive integer `limit`. Omitting it preserves
the existing complete listing behavior. Supplying it creates a hard adapter accumulation bound:
the adapter returns at most `limit` entries and does not first materialize the whole directory.

The result always reports `truncated`:

- `false` means the adapter reached end-of-directory before the limit and the result is complete;
- `true` means the requested limit was reached and additional entries may exist. It is deliberately
  conservative when the directory contains exactly `limit` entries because the adapter does not read
  an extra entry merely to prove EOF.

Returned entries are sorted by name within the returned bounded set. A bounded result does not claim
to be the globally first lexicographic page because native directory iteration order is not a portable
snapshot contract.

## Ownership and interface

- Contract owner: `@lcode/contracts` `FileSystemPort`.
- Node I/O owner: `@lcode/adapters` Node filesystem adapter.
- Callers choose whether they require complete compatibility behavior or a bounded listing.
- Project Memory recall passes the remaining core entry budget as `limit`; it keeps its own defensive
  slice for alternate/test adapters that violate or predate the contract.

No database, protocol, UI state, runtime queue, or persistence owner is added.

## Validation and failure semantics

- `limit` must be a positive safe integer. Invalid values fail with `FileSystemPortError` code
  `invalid_limit`; they never fall back to an unbounded read.
- Cancellation is checked before opening and between entry reads. The directory handle is closed in a
  `finally` boundary on success, failure, and cancellation.
- Existing path normalization, not-directory, permission, missing-path, and cancellation errors keep
  their current normalized `FileSystemPortError` behavior.
- The bounded path may inspect native buffering internal to Node/the OS, but the adapter's JavaScript
  result accumulator and mapped entry array never exceed `limit`.

## Event order

```text
caller computes remaining budget
  → FileSystemPort.listDirectory(path, limit)
  → adapter validates path + limit
  → open directory handle
  → read/map at most limit entries, checking cancellation
  → close handle in finally
  → sort bounded set and return entries + truncated
  → caller applies its domain filters and remaining budget
```

## Acceptance cases

| ID    | Setup/action                                    | Assertions                                                                 |
| ----- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| FSL-1 | Omit `limit` on a directory with several files  | Complete name-sorted result; `truncated=false`                             |
| FSL-2 | Set `limit=3` on a wider directory              | At most three mapped entries; `truncated=true`                             |
| FSL-3 | Set a limit larger than the directory           | All entries returned; `truncated=false`                                    |
| FSL-4 | Set `limit` to 0, fractional, unsafe, or `NaN`  | `invalid_limit`; no unbounded fallback                                     |
| FSL-5 | Abort during bounded iteration                  | Handle closes and the normalized error code is `cancelled`                 |
| FSL-6 | Project Memory has 4,096 remaining entry budget | Its real adapter request carries `limit=4096`; core still processes ≤4,096 |

## Out of scope

- Stable snapshot pagination or resume cursors across concurrent directory mutation.
- A globally lexicographic bounded page without enumerating the whole directory.
- Atomic no-follow reads; symlink list-to-read races require a separate contained-read contract.
