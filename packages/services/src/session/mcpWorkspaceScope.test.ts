import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LCodeAgentMcpServer } from "@lcode/shared";
import { appendWorkspaceToFilesystemMcpServers } from "./mcpWorkspaceScope.js";

test("filesystem MCP receives every existing project folder once", async () => {
  const root = await mkdtemp(join(tmpdir(), "lcode-project-roots-"));
  const primary = join(root, "primary");
  const secondary = join(root, "secondary");
  const missing = join(root, "missing");
  await Promise.all([mkdir(primary), mkdir(secondary)]);
  const servers: LCodeAgentMcpServer[] = [
    {
      name: "filesystem",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", primary],
      env: [],
    },
  ];
  const filesystemServer = servers[0]!;
  if (!("args" in filesystemServer)) {
    throw new Error("expected a stdio filesystem MCP server");
  }

  try {
    const result = appendWorkspaceToFilesystemMcpServers(servers, [
      primary,
      secondary,
      secondary,
      missing,
    ]);
    assert.deepEqual(result?.[0], {
      ...filesystemServer,
      args: [...filesystemServer.args, secondary],
    });
    assert.deepEqual(filesystemServer.args, [
      "-y",
      "@modelcontextprotocol/server-filesystem",
      primary,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
