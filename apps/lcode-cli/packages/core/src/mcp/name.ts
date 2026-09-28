import type { McpToolDescriptor } from "@lcode/contracts";

export function toMcpToolName(
  descriptor: Pick<McpToolDescriptor, "name" | "serverName" | "toolName">,
): string {
  return (
    descriptor.name ??
    `mcp__${toModelVisibleMcpNamePart(descriptor.serverName)}__${toModelVisibleMcpNamePart(
      descriptor.toolName,
    )}`
  );
}

export function toModelVisibleMcpNamePart(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
  return sanitized.length > 0 ? sanitized : "unknown";
}

export function matchesModelVisibleMcpServerName(
  requiredName: string,
  serverName: string,
): boolean {
  const expected = requiredName.trim().toLowerCase();
  if (expected.length === 0) return false;

  const rawServerName = serverName.trim().toLowerCase();
  const modelVisibleServerName = toModelVisibleMcpNamePart(serverName).toLowerCase();

  return (
    rawServerName === expected ||
    modelVisibleServerName === expected ||
    rawServerName.includes(expected) ||
    modelVisibleServerName.includes(expected)
  );
}
