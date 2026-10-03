import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import test from "node:test";
import type { LCodeAgentMcpServer } from "@lcode/shared";
import { remapFilesystemMcpServers, filesystemMcpRoots } from "./worktree-mcp-scope.js";

const repositoryRoot = resolve("fixture-origin");
const checkoutPath = resolve("fixture-worktree");
const binding = { repositoryRoot, checkoutPath, workspacePath: checkoutPath };
function server(roots: string[]): LCodeAgentMcpServer {
  return {
    name: "filesystem",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", ...roots],
    env: [],
  };
}

test("worktree maps filesystem MCP repository root and children without keeping source authorization", () => {
  const servers = [server([repositoryRoot, join(repositoryRoot, "src")])];
  const mapped = remapFilesystemMcpServers(servers, binding, repositoryRoot);
  assert.deepEqual(filesystemMcpRoots(mapped, checkoutPath), [
    checkoutPath,
    join(checkoutPath, "src"),
  ]);
  assert.deepEqual(filesystemMcpRoots(servers, repositoryRoot), [
    repositoryRoot,
    join(repositoryRoot, "src"),
  ]);
});

test("worktree rejects external and ancestor filesystem roots", () => {
  assert.throws(
    () => remapFilesystemMcpServers([server([resolve("external")])], binding, repositoryRoot),
    /outside/,
  );
  assert.throws(
    () => remapFilesystemMcpServers([server([resolve(".")])], binding, repositoryRoot),
    /outside/,
  );
});

test("worktree keeps unrelated MCP unchanged and adds its actual root when no roots configured", () => {
  const custom = { name: "docs", command: "npx", args: ["docs-server"], env: [] };
  const mapped = remapFilesystemMcpServers([custom, server([])], binding, repositoryRoot);
  assert.equal(mapped?.[0], custom);
  assert.deepEqual(filesystemMcpRoots(mapped, checkoutPath), [checkoutPath]);
});

test("worktree accepts restored MCP roots already mapped to the same checkout", () => {
  assert.deepEqual(
    filesystemMcpRoots(
      remapFilesystemMcpServers([server([checkoutPath])], binding, repositoryRoot),
      checkoutPath,
    ),
    [checkoutPath],
  );
});
