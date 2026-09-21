# Lemon Workflow

Official built-in content plugin for ZCode. It provides:

- `/lemon`: starts a new dynamic workflow or resumes an explicitly selected resumable run.
- `ponytail`: minimal, code-first engineering guidance from Dietrich Gebert's Ponytail project.
- `caveman`: terse response guidance from Julius Brussee's Caveman project.
- `dynamic-workflows`: ZCode workflow authoring and recovery guidance.

The plugin has no MCP server or separate runtime. Workflow execution and persistence remain owned by
ZCode's existing dynamic workflow runtime and run journal.

Ponytail and Caveman skill content is vendored under MIT. Their original license files are stored
beside the corresponding skills. ZCode-specific command and workflow guidance follows the repository's
Apache-2.0 license.
