import type { Event } from "@lcode/rpc";
import type { WorktreeScope } from "../worktree/contract.js";
import type { ExecutionSetSnapshot } from "@lcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IProjectExecutionSetService {
  capabilities(): Promise<{ protocolVersion: 1; multiRepository: true }>;
  get(request: WorktreeScope & { executionSetId: string }): Promise<ExecutionSetSnapshot | null>;
  list(request: WorktreeScope): Promise<ExecutionSetSnapshot[]>;
  bindings(
    request: WorktreeScope & { executionSetId: string },
  ): Promise<import("@lcode/shared").ExecutionSetRepositoryView[]>;
  retry(
    request: WorktreeScope & { executionSetId: string; operationId: string },
  ): Promise<ExecutionSetSnapshot>;
  rename(
    request: WorktreeScope & {
      executionSetId: string;
      name: string;
      expectedRevision: number;
      operationId: string;
    },
  ): Promise<ExecutionSetSnapshot>;
  archive(
    request: WorktreeScope & {
      executionSetId: string;
      operationId: string;
      acknowledgeIgnoredFiles?: boolean;
    },
  ): Promise<ExecutionSetSnapshot>;
  restore(
    request: WorktreeScope & { executionSetId: string; operationId: string },
  ): Promise<ExecutionSetSnapshot>;
  onDidChange: Event<ExecutionSetSnapshot>;
}
export type ProjectExecutionSetHostService = IProjectExecutionSetService &
  import("./hostContract.js").ProjectExecutionSetHostActions;
export const IProjectExecutionSetService =
  createServiceDescriptor<IProjectExecutionSetService>("projectExecutionSet");
