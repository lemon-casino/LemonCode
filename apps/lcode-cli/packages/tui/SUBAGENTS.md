# Subagent observation in the TUI

- The right sidebar lists the current main session's subagents, including ended children.
- Selecting a child replaces the left pane with its read-only transcript. The main runtime keeps running.
- Back / Escape restores the main composer, draft and transcript scroll position.
- Main transcript admission rejects both foreign session IDs and parent-session tool mirrors (`source: subagent`).
- Bootstrap owns directory interpretation and persisted transcript reads. Reuse the protocol's subagent projector; TUI owns selection, folding and rendering only.
- Subscribe before reading child history, buffer concurrent events and apply only events above the snapshot watermark. Ignore stale loads after selection/session changes.
- Lifecycle events invalidate the directory; streaming tokens update the selected transcript directly. No polling and no per-token history queries.
- Parent tool completion or parent turn completion cannot terminate a child. Child facts determine its status.
- Read-only keyboard handling precedes composer and approval shortcuts. Pending main interactions remain visible as a return-to-main notice.
- Validate with real OpenTUI rendering: click, live output, return, preserved draft/scroll, isolation, stale requests and narrow terminals.
