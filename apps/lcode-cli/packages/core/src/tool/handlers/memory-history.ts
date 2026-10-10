import {
  MEMORY_HISTORY_TOOL_NAME,
  MemoryHistoryInputSchema,
  MemoryHistoryInputJsonSchema,
  MemoryHistoryOutputSchema,
  MemoryHistoryOutputJsonSchema,
} from "@lcode/contracts";
import type { ToolEntry } from "../types.js";
import { memoryEffectWorkspaceKey } from "../../memory/effect-observation.js";
import {
  assertInteractiveMemoryMutation,
  memoryManagedPermission,
  memoryReadPermission,
  memoryToolMetadata,
  memoryToolPolicies,
  memoryError,
  requireMemory,
} from "./memory-common.js";

export const memoryHistoryToolEntry: ToolEntry = {
  ...memoryToolPolicies,
  capability: "Inspect managed memory changes or conditionally undo a replacement",
  metadata: memoryToolMetadata(
    MEMORY_HISTORY_TOOL_NAME,
    "List managed memory changes or bounded effects observations. Use effects to find an actual injected session/turn, fileName and sourceHash. Use feedback only for the user's explicitly stated relevant/irrelevant/correction feedback; it requires a separate user approval and never infers benefit from task success. Use undo only when the user asks to revert an incorrect change; pass changeId and afterHash as expectedHash. Undo preserves newer external edits. Automatic maintenance does not require this tool.",
    true,
  ),
  permission: memoryManagedPermission,
  resolvePermissionCapability: (input) => {
    const parsed = MemoryHistoryInputSchema.safeParse(input);
    if (parsed.success && parsed.data.action === "feedback")
      return {
        readOnly: false,
        needsApproval: true,
        sideEffectScope: "workspace",
        permission: {
          ...memoryManagedPermission,
          permission: "memory.feedback",
          reason: "Record this user's explicit feedback for one actually injected memory revision",
          needsApproval: true,
          alwaysAsk: true,
          approvalSource: "user",
          askOptions: { allowAlways: false },
        },
      };
    return parsed.success && (parsed.data.action === "list" || parsed.data.action === "effects")
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
    if (parsed.action === "effects" || parsed.action === "feedback") {
      if (!port.effects)
        throw memoryError("Memory effect observation is unavailable for this adapter.");
      // memoryRoot 的 owner identity 来自记忆配置；执行绑定可能不同，不能据此重算账本作用域。
      const workspaceKey = memoryEffectWorkspaceKey(
        context.memoryWorkspaceIdentity,
        context.workspaceRoot,
      );
      if (parsed.action === "effects")
        return {
          status: "effects",
          snapshot: await port.effects.read({ rootDir, workspaceKey }, options),
        };
      assertInteractiveMemoryMutation(context);
      if (!context.toolCallId)
        throw memoryError("Memory feedback requires an admitted tool call identity.");
      return {
        status: "feedback",
        result: await port.effects.recordFeedback(
          {
            rootDir,
            feedback: {
              schemaVersion: 1,
              workspaceKey,
              commandId: context.toolCallId,
              sessionId: parsed.effectSessionId!,
              turnId: parsed.effectTurnId!,
              fileName: parsed.fileName!,
              sourceHash: parsed.expectedHash!,
              feedback: parsed.feedback!,
              recordedAt: Date.now(),
            },
          },
          options,
        ),
      };
    }
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
