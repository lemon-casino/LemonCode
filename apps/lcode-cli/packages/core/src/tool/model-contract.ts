import type { ModelToolContract } from "@lcode/contracts";
import type { ToolEntry, ToolExecutionModelContext } from "./types.js";

export function resolveToolEntryModelContract(
  entry: ToolEntry,
  context: ToolExecutionModelContext,
): ToolEntry {
  const projection = entry.resolveModelContract?.(context);
  if (!projection) return entry;
  return {
    ...entry,
    ...(projection.inputSchema ? { inputSchema: projection.inputSchema } : {}),
    metadata: {
      ...entry.metadata,
      ...(projection.description !== undefined ? { description: projection.description } : {}),
    },
  };
}

export function projectToolModelContract(
  contract: ModelToolContract,
  entry: ToolEntry | undefined,
  context: ToolExecutionModelContext,
): ModelToolContract {
  if (!entry) return contract;
  const projection = entry.resolveModelContract?.(context);
  if (!projection) return contract;
  return {
    ...contract,
    ...(projection.description !== undefined ? { description: projection.description } : {}),
    ...(projection.inputSchema ? { inputSchema: projection.inputSchema } : {}),
  };
}
