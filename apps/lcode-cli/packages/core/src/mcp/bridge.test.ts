import assert from "node:assert/strict";
import test from "node:test";
import {
  LCODE_MCP_ERROR_PRESENTATION_MESSAGE_ONLY,
  LCODE_MCP_ERROR_PRESENTATION_META_KEY,
  PermissionCapabilityGroup,
  type McpPort,
  type McpToolDescriptor,
} from "@lcode/contracts";
import {
  LCODE_CUA_OFFICIAL_MCP_NAMESPACE_NAME,
  OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME,
} from "@lcode/shared";
import { PermissionService } from "../permission/service.js";
import { ToolRegistryImpl } from "../tool/registry.js";
import type { ToolExecutionContext } from "../tool/types.js";
import { registerMcpTools, toMcpToolName } from "./index.js";

const descriptor: McpToolDescriptor = {
  serverName: LCODE_CUA_OFFICIAL_MCP_NAMESPACE_NAME,
  toolName: "get_app_state",
  inputSchema: { type: "object", properties: { app: { type: "string" } } },
};

function register(verified: boolean) {
  const registry = new ToolRegistryImpl();
  const calls: unknown[] = [];
  const mcpPort = {
    callTool: async (request: unknown) => {
      calls.push(request);
      return { content: [{ type: "text", text: "mock observation" }] };
    },
  } as unknown as McpPort;
  const names = registerMcpTools(
    registry,
    mcpPort,
    [descriptor],
    verified
      ? {
          officialCuaServerNames: new Set([descriptor.serverName]),
        }
      : {},
  );
  return { registry, calls, mcpPort, names, entry: registry.get(names[0]!)! };
}

test("MCP name alone cannot acquire official CUA authority or permission grants", () => {
  const ordinary = register(false);
  const trusted = register(true);
  assert.equal(ordinary.names[0], toMcpToolName(descriptor));
  assert.equal(ordinary.entry.permissionCapabilityGroup, undefined);
  assert.equal(ordinary.entry.modelContentProtection, undefined);
  assert.equal(ordinary.registry.has("mcp__computer_use__get_app_state"), false);
  assert.equal(trusted.names[0], "mcp__computer-use__get_app_state");
  assert.equal(trusted.entry.permissionCapabilityGroup, PermissionCapabilityGroup.OfficialCua);
  assert.equal(trusted.registry.get("mcp__computer_use__get_app_state"), trusted.entry);
  const rules = {
    version: 1 as const,
    allow: [{ toolName: OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME }],
  };
  const service = new PermissionService();
  for (const [entry, decision] of [
    [ordinary.entry, "ask"],
    [trusted.entry, "allow"],
  ] as const) {
    assert.equal(
      service.checkPermission(
        {
          toolName: entry.metadata.name,
          input: {},
          mode: "build",
          riskLevel: "medium",
        },
        {
          permission: entry.permission,
          permissionCapabilityGroup: entry.permissionCapabilityGroup,
        },
        rules,
      ).decision,
      decision,
    );
  }
  const denied = new ToolRegistryImpl();
  assert.deepEqual(
    registerMcpTools(denied, trusted.mcpPort, [descriptor], {
      officialCuaServerNames: new Set([descriptor.serverName]),
      disallowedTools: [toMcpToolName(descriptor)],
    }),
    [],
  );
});

test("MCP dispatch preserves original route, strips only title, and propagates replay identity", async () => {
  const setup = register(true);
  const context = {
    traceId: "mcp-trace",
    sessionId: "mcp-session",
    turnId: "mcp-turn",
    toolCallId: "mcp-call",
    workingDirectory: process.cwd(),
    workspaceRoot: process.cwd(),
    workspaceIdentity: " workspace-key ",
    remoteSessionId: "remote-session",
    clientMode: "web-remote-replayable",
    deliveryKind: "web-remote-replayable",
  } as ToolExecutionContext;
  await setup.entry.handler({ title: "Inspect test app", app: "test-app" }, context);
  const request = setup.calls[0] as Record<string, unknown>;
  assert.equal(request.serverName, descriptor.serverName);
  assert.equal(request.toolName, descriptor.toolName);
  assert.deepEqual(request.arguments, { app: "test-app" });
  assert.equal(request.workspaceIdentity, "workspace-key");
  assert.equal(request.workspaceKey, "workspace-key");
  assert.equal(request.remoteSessionId, "remote-session");
  assert.equal(request.deliveryKind, "web-remote-replayable");
});

test("MCP result projection keeps media order and explicit message-only errors", () => {
  const { entry } = register(false);
  const output = {
    content: [
      { type: "text", text: "before" },
      { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      { type: "text", text: "after" },
    ],
    structuredContent: {},
  };
  const content = entry.formatModelContent!(output);
  assert.ok(Array.isArray(content));
  assert.deepEqual(
    content.map((block) => block.type),
    ["text", "image", "text"],
  );
  const failure = { content: [{ type: "text", text: "denied" }], isError: true };
  assert.equal(entry.formatModelContent!(failure), "MCP tool returned an error:\ndenied");
  assert.equal(
    entry.formatModelContent!({
      ...failure,
      _meta: { [LCODE_MCP_ERROR_PRESENTATION_META_KEY]: LCODE_MCP_ERROR_PRESENTATION_MESSAGE_ONLY },
    }),
    "denied",
  );
});
