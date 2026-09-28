import { PermissionCapabilityGroup, type PermissionUpdate } from "@lcode/contracts";
import { OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME } from "@lcode/shared";

const PROJECT_RULE_INPUT_KEYS = ["command", "url", "file_path", "path", "pattern"] as const;

export function buildDefaultPermissionUpdates(
  toolName: string,
  input: unknown,
  capabilityGroup?: PermissionCapabilityGroup,
): PermissionUpdate[] {
  if (capabilityGroup) {
    if (capabilityGroup !== PermissionCapabilityGroup.OfficialCua) {
      throw new Error(`Unsupported permission capability group: ${capabilityGroup}`);
    }
    return [
      {
        behavior: "allow",
        rules: [{ toolName: OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME }],
        type: "addRules",
      },
    ];
  }

  const ruleContent = ruleContentFromInput(input);
  return [
    {
      behavior: "allow",
      rules: [
        {
          toolName,
          ...(ruleContent ? { ruleContent } : {}),
        },
      ],
      type: "addRules",
    },
  ];
}

function ruleContentFromInput(input: unknown): string | undefined {
  if (typeof input === "string" && input.trim().length > 0) return input;
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of PROJECT_RULE_INPUT_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}
