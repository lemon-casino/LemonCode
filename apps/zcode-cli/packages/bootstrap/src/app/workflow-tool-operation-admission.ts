import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  CoreErrorType,
  createCoreError,
  isWorkspaceMutatingToolCall,
  type ToolOperationAdmissionPort,
} from "@zcode/contracts";

type Intent = { path: string | undefined; write: boolean };
type Waiter = {
  intent: Intent;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal: AbortSignal | undefined;
  onAbort: () => void;
};

function conflicts(left: Intent, right: Intent): boolean {
  return (left.write || right.write) &&
    (left.path === undefined || right.path === undefined || left.path === right.path);
}

async function canonicalPath(path: string, cwd: string): Promise<string | undefined> {
  const absolute = resolve(cwd, path);
  let result: string;
  try {
    result = await realpath(absolute);
  } catch {
    try {
      result = resolve(await realpath(dirname(absolute)), basename(absolute));
    } catch {
      // Cannot prove the file's identity (e.g. a missing parent): serialize with the workspace.
      return undefined;
    }
  }
  return process.platform === "win32" ? result.toLowerCase() : result;
}

async function operationIntent(input: Parameters<ToolOperationAdmissionPort["acquire"]>[0]): Promise<Intent | undefined> {
  const write = isWorkspaceMutatingToolCall(input);
  const read = input.readOnly === true &&
    input.sideEffectScope !== "network" && input.sideEffectScope !== "session" &&
    input.sideEffectScope !== "userInteraction";
  if (!write && !read) return undefined;
  const knownFile = input.toolName === "Read" || input.toolName === "Edit" || input.toolName === "Write";
  const path = knownFile && typeof input.toolInput === "object" && input.toolInput !== null &&
    "file_path" in input.toolInput && typeof input.toolInput.file_path === "string"
    ? await canonicalPath(input.toolInput.file_path, input.workingDirectory)
    : undefined;
  return { path, write };
}

export function createWorkflowToolOperationAdmission(): ToolOperationAdmissionPort {
  const active = new Set<Intent>();
  const queued: Waiter[] = [];

  const drain = () => {
    const preceding: Intent[] = [];
    for (let i = 0; i < queued.length;) {
      const waiter = queued[i]!;
      if ([...active, ...preceding].some((intent) => conflicts(intent, waiter.intent))) {
        preceding.push(waiter.intent);
        i += 1;
        continue;
      }
      queued.splice(i, 1);
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      active.add(waiter.intent);
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        active.delete(waiter.intent);
        drain();
      });
    }
  };

  return {
    async acquire(input) {
      if (input.signal?.aborted) throw createCoreError(CoreErrorType.ToolCancelled, "Tool execution cancelled");
      const intent = await operationIntent(input);
      if (input.signal?.aborted) throw createCoreError(CoreErrorType.ToolCancelled, "Tool execution cancelled");
      if (intent === undefined) return () => {};
      return new Promise<() => void>((resolveLease, reject) => {
        const waiter: Waiter = {
          intent,
          resolve: resolveLease,
          reject,
          signal: input.signal,
          onAbort: () => {
            const index = queued.indexOf(waiter);
            if (index < 0) return;
            queued.splice(index, 1);
            waiter.signal?.removeEventListener("abort", waiter.onAbort);
            waiter.reject(createCoreError(CoreErrorType.ToolCancelled, "Tool execution cancelled"));
            drain();
          },
        };
        queued.push(waiter);
        input.signal?.addEventListener("abort", waiter.onAbort, { once: true });
        if (input.signal?.aborted) waiter.onAbort();
        drain();
      });
    },
  };
}
