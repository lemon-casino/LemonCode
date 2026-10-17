# Project execution set

Target Host owns a durable immutable repository plan and progress. Profile Settings owns project
definitions; only trusted CLI admission may provide its versioned snapshot. Public RPC exposes
queries and explicit retry/rename/archive/restore, never prepare, consumer release or checkout permissions.

Prepare persists the plan before creating a checkout. Same repository members share one binding;
different repositories receive explicit set/repository owners. First input admission is allowed
only after every required binding is ready and its session consumer is durable. Retries preserve
the original request, scope, base refs and successful bindings. Failure returns each repository's
reason and does not reroute to original directories. One set does not imply atomic multi-repo Git.

The bindings read model includes the latest integration receipt for each owned binding. It reads
the original WorktreeService operation, verifies the binding ID and projects status and frozen
heads; it never mutates publication or copies its authoritative state into the set journal.
Published means the candidate was integrated into the target branch, not that a remote was pushed.

WorktreeService alone creates and mutates bindings and durable consumer receipts. ExecutionSet
stores references and progress. Execution leases use the existing checkout coordinator in stable
order and release already-acquired permits after failure. Archive first obtains trusted session
stop receipts, then releases consumers and archives each binding with the original operation ID.
No timeout or lost connection is stop evidence. Partial archive is retained and retryable.

Concurrent chats intentionally share the same files and take shared execution permits. Integration,
archive and lifecycle changes remain exclusive; a shared execution permit does not serialize AI
file edits or provide per-chat isolation. Independent forks are the isolated alternative.

Desktop continuous and mobile replayable read the same session executionSetRef and frozen input
context. Reconnect does not change paths or allocate a second set. Unknown versions fail closed.

The original preparation name, bases and optional fork source are immutable even after a display
rename. A fork allocates independent repository bindings and copies each source checkout snapshot.
Archive journals the chat visibility change before applying it, preserves already archived chats,
and restores only chats archived by that set operation. Restore reattaches set consumers before
publishing ready. Subscribers observe committed revisions across Host instances through a scoped
directory watcher; the last subscription releases that watcher.

Version 1 runs inside one target Host's local execution environment. SSH, WSL and Docker target
Hosts follow the same contract. Managed runtime-environment transfer, mixed Hosts, submodules and
non-Git isolation are rejected before execution. Public capabilities do not imply those features.
