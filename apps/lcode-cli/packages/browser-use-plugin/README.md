# Browser Use

The official built-in LCode plugin for browser automation. It ships the browser-client bootstrap module, skills, and documentation/capability manifests; the `node_repl` MCP host that exposes the `js` tool lives in `@lcode/node-repl-host`.

## What it provides

- `js` tool — served by the shared `node_repl` MCP host and seen by the model as `mcp__node_repl__js`. The host is shared with Computer Use, so its model-facing text is scoped to both official capabilities. Every `js` call starts in a fresh kernel; imports are limited to `node:*` builtins and absolute `file://` URLs under the skill root.
- `scripts/browser-client.mjs` — explicitly bootstraps `agent.browsers` inside each fresh `js` kernel; BrowserControl tabs, not JavaScript globals, provide continuity.
- `control-browser` skill — tells the agent how to bootstrap and drive an advertised LCode browser backend (Desktop IAB or CLI-managed headless CDP), select a browser and read `browser.documentation()` once, use the Playwright DOM snapshot→locator→act workflow, observe controlled and user tab registries together after a possible popup action, and request screenshots only for visual evidence.
- `web-gui-tester` skill — layers a pure-GUI black-box testing workflow on top of `control-browser`, requiring Browser Use semantic evidence plus inspected screenshots while respecting current console, upload, and runtime capability boundaries.

The IAB runtime is provided by the desktop host; the managed headless CDP runtime is provided only by an explicitly opted-in CLI process. The plugin assets define the model guidance and the effective runtime object graph; unsupported members are removed by the manifest interpreter instead of failing after invocation.
