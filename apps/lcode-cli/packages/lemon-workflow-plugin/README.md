# Lemon Workflow

Official built-in content plugin for LCode. It provides:

- `/lemon`: starts a new dynamic workflow or resumes an explicitly selected resumable run.
- `ponytail`: minimal, code-first engineering guidance from Dietrich Gebert's Ponytail project.
- `caveman`: terse response guidance from Julius Brussee's Caveman project.
- `dynamic-workflows`: LCode workflow authoring and recovery guidance.

`/lemon` applies Ponytail selectively to workflow topology and to engineering actors that already
belong in the task. Caveman applies only to short user-visible progress and completion summaries;
structured actor results, evidence, errors, safety warnings, reports, and artifacts stay complete.
Neither skill creates a dedicated actor, proxy, engine, hook, or second workflow state owner.

The plugin has no MCP server or separate runtime. Workflow execution and persistence remain owned by
LCode's existing dynamic workflow runtime and run journal.

Ponytail and Caveman skill content is vendored under MIT. Their original license files are stored
beside the corresponding skills. LCode-specific command and workflow guidance follows the repository's
Apache-2.0 license.
