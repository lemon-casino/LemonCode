import assert from "node:assert/strict";
import test from "node:test";
import { projectContextForDefinition } from "@lcode/shared";
import { prepareProjectFilesystemMcp } from "./project-filesystem-mcp.js";

test("filesystem MCP adopts the frozen member paths after old prewarm settles and keeps unrelated servers", async () => {
  const snapshot = projectContextForDefinition({ id: "p", name: "Project", revision: 2, primaryFolderPath: "/web", sourceFolderPaths: ["/web", "/api"] }, { workspacePath: "/web" });
  let settle!: () => void;
  const prewarm = new Promise<void>((resolve) => { settle = resolve; });
  let connects = 0;
  const unrelated = { type: "http", url: "https://fixture.invalid/mcp" };
  const runtime = {
    config: { mcp: { enabled: true, servers: { filesystem: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/old"] }, docs: unrelated } } },
    workingDirectory: "/web", mcpPort: {}, mcpInitialized: true, mcpToolsRegistered: true, mcpStartupPromise: prewarm,
    startMcpStartup: async () => { connects++; return { statuses: { filesystem: { status: "connected" } } }; },
    initializeMcp: async () => { runtime.mcpToolsRegistered = true; },
  };
  const preparing = prepareProjectFilesystemMcp(runtime as never, snapshot, { traceId: "fixture" } as never);
  await Promise.resolve(); assert.equal(connects, 0);
  settle(); await preparing;
  assert.deepEqual(runtime.config.mcp.servers.filesystem.args, ["-y", "@modelcontextprotocol/server-filesystem", "/web", "/api"]);
  assert.equal(runtime.config.mcp.servers.docs, unrelated);
  await prepareProjectFilesystemMcp(runtime as never, snapshot, { traceId: "fixture" } as never);
  assert.equal(connects, 1, "identical admitted scope does not reconnect");
  runtime.startMcpStartup = async () => ({ statuses: {} }) as never;
  await assert.rejects(prepareProjectFilesystemMcp(runtime as never, { ...snapshot, members: snapshot.members.slice(0, 1) }, { traceId: "fixture" } as never), /could not adopt/);
  assert.deepEqual(runtime.config.mcp.servers.filesystem.args.slice(-1), ["/web"]);
});
