import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { TestContext } from "node:test";
import type {
  DynamicWorkflowSnippetEvalRequest,
  DynamicWorkflowSnippetEvalResult,
  LogContext,
  Logger,
  PermissionBrokerRequest,
  PermissionBrokerResult,
  SessionEvent,
} from "@lcode/contracts";
import { createSessionId } from "@lcode/contracts";
import type { HookRunner } from "../../hooks/index.js";
import { PermissionService } from "../../permission/service.js";
import { createToolExecutor } from "../executor/impl.js";
import { ToolRegistryImpl } from "../registry.js";
import { evalWorkflowSnippetToolEntry } from "./eval-workflow-snippet.js";

const TEMP_PREFIX = "lcode-snippet-contract-";

export async function snippetFixture(
  t: TestContext,
  options: {
    mode?: "build" | "yolo";
    deliveryKind?: "desktop-continuous" | "web-remote-replayable";
    afterResolution?: (input: unknown, directory: string) => Promise<void>;
    hookRunner?: HookRunner;
    answer?: (request: PermissionBrokerRequest) => PermissionBrokerResult;
    result?: DynamicWorkflowSnippetEvalResult;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.startsWith(join(tmpdir(), TEMP_PREFIX)));
    await rm(directory, { recursive: true, force: true });
  });
  const stages = { resolve: 0, hook: 0, handler: 0 };
  const requests: DynamicWorkflowSnippetEvalRequest[] = [];
  const approvals: PermissionBrokerRequest[] = [];
  const events: SessionEvent[] = [];
  const debug: Array<{ message: string; context?: LogContext }> = [];
  const logger: Logger = {
    debug: (message, context) => {
      debug.push({ message, context });
    },
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  };
  const registry = new ToolRegistryImpl();
  registry.register({
    ...evalWorkflowSnippetToolEntry,
    resolveInput: async (input, context) => {
      stages.resolve++;
      const result = await evalWorkflowSnippetToolEntry.resolveInput!(input, context);
      if (result.result) await options.afterResolution?.(result.input, directory);
      return result;
    },
    handler: async (input, context) => {
      stages.handler++;
      return evalWorkflowSnippetToolEntry.handler(input, context);
    },
  });
  const executor = createToolExecutor({
    registry,
    sessionId: createSessionId(),
    workspaceIdentity: "snippet-fixture-identity",
    remoteSessionId: "snippet-fixture-remote",
    clientMode: options.deliveryKind ?? "desktop-continuous",
    deliveryKind: options.deliveryKind ?? "desktop-continuous",
    getWorkingDirectory: () => directory,
    getWorkspaceRoot: () => directory,
    getMode: () => options.mode ?? "yolo",
    permissionService: new PermissionService(),
    permissionBroker: {
      requestPermission: async (request) => {
        approvals.push(request);
        return options.answer?.(request) ?? { decision: "allow" };
      },
    },
    hookRunner: {
      run: async (...args) => {
        stages.hook++;
        return options.hookRunner?.run(...args) ?? { additionalContexts: [] };
      },
    } as HookRunner,
    logger,
    dynamicWorkflowSnippetPort: {
      evalSnippet: async (request) => {
        requests.push(request);
        return (
          options.result ?? {
            kind: "completed",
            artifact: "fixture",
            logs: [],
            logsTruncated: false,
          }
        );
      },
    },
    emitEvent: async (event) => {
      events.push(event);
    },
  });
  const execute = (input: unknown, id = "snippet-call") =>
    executor.execute({ id, name: "EvalWorkflowSnippet", input });
  return { directory, execute, stages, requests, approvals, events, debug, registry };
}
