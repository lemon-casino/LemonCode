import {
  MEMORY_HISTORY_TOOL_NAME,
  MemoryHistoryInputSchema,
  MemoryHistoryInputJsonSchema,
  MemoryHistoryOutputSchema,
  MemoryHistoryOutputJsonSchema,
} from "@lcode/contracts";
import type { ToolEntry } from "../types.js";
import {
  assertInteractiveMemoryMutation,
  memoryManagedPermission,
  memoryReadPermission,
  memoryToolMetadata,
  memoryToolPolicies,
  requireMemory,
} from "./memory-common.js";

export const memoryHistoryToolEntry: ToolEntry = {
  ...memoryToolPolicies,
  capability: "Inspect managed memory changes or conditionally undo a replacement",
  metadata: memoryToolMetadata(
    MEMORY_HISTORY_TOOL_NAME,
    "List changes made by the managed workspace memory writer. Use undo only when the user asks to revert an incorrect memory change; pass its changeId and afterHash as expectedHash. Undo preserves newer external edits and cannot delete a newly created file. Automatic memory maintenance does not require using this tool.",
    true,
  ),
  permission: memoryManagedPermission,
  resolvePermissionCapability: (input) => {
    const parsed = MemoryHistoryInputSchema.safeParse(input);
    return parsed.success && parsed.data.action === "list"
      ? {
          readOnly: true,
          needsApproval: false,
          sideEffectScope: "none",
          permission: memoryReadPermission,
        }
      : undefined;
  },
  inputSchema: MemoryHistoryInputJsonSchema,
  runtimeInputSchema: MemoryHistoryInputSchema,
  outputSchema: MemoryHistoryOutputJsonSchema,
  runtimeOutputSchema: MemoryHistoryOutputSchema,
  handler: async (input, context) => {
    const parsed = MemoryHistoryInputSchema.parse(input);
    const { rootDir, port } = requireMemory(context);
    const options = { signal: context.abortSignal, trace: context.traceContext };
    if (parsed.action === "list")
      return { status: "list", changes: await port.listChanges(rootDir, options) };
    assertInteractiveMemoryMutation(context);
    const preview = await port.previewUndo({ rootDir, changeId: parsed.changeId! }, options);
    const change = await port.undoChange(
      {
        rootDir,
        changeId: parsed.changeId!,
        expectedHash: parsed.expectedHash!,
        expectedBeforeHash: preview.change.beforeHash!,
      },
      options,
    );
    return { status: "committed", change };
  },
};
