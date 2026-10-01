import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createSessionId,
  createRootTraceContext,
  type BrowserControlPort,
  type Model,
  type SkillPort,
} from "@lcode/contracts";
import { AgentRuntime } from "../agent-runtime.js";
import type { AgentRuntimeInternal } from "../internal.js";

test("ordinary Agent creation inherits browser tooling and skill policy, then closes only its child scope", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-agent-browser-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const active = new Set<string>();
  const closed: string[] = [];
  const browserPort: BrowserControlPort = {
    async list() {
      return [];
    },
    async execute() {
      return { ok: true, elapsedMs: 0 };
    },
    createChildScope({ sessionId, parentSessionId }) {
      assert.equal(parentSessionId, parentId);
      active.add(sessionId);
      return {
        async list(input) {
          assert.equal(input.sessionId, sessionId);
          assert.ok(active.has(sessionId));
          return [];
        },
        async execute() {
          return { ok: true, elapsedMs: 0 };
        },
        async closeSession(input) {
          assert.equal(input.sessionId, sessionId);
          closed.push(sessionId);
          active.delete(sessionId);
        },
      };
    },
  };
  const metadata = {
    name: "control-browser",
    qualifiedName: "browser-use:control-browser",
    pluginId: "browser-use@test",
    path: "plugin/SKILL.md",
    directory: "plugin",
    rootPath: "plugin",
    scope: "user",
    source: "plugin",
    description: "Browser",
    safeToAutoLoad: true,
    frontmatterKeys: [],
  } as const;
  const skillPort: SkillPort = {
    discoverSkills: async () => ({
      skills: [{ ...metadata, frontmatterKeys: [] }],
      diagnostics: [],
      totalDiscovered: 1,
    }),
    loadSkill: async () => ({
      metadata: { ...metadata, frontmatterKeys: [] },
      content: "browser instructions",
      baseDirectory: "plugin",
      bytesRead: 20,
      sizeBytes: 20,
      truncated: false,
    }),
  };
  const parentId = createSessionId("parent-browser");
  const model = {
    providerId: "test",
    modelId: "test",
    options: {},
    properties: { contextWindow: 200_000 },
  } as Model;
  let sequence = 0;
  const parent = new AgentRuntime(
    parentId,
    {
      workingDirectory: directory,
      mode: "yolo",
      modelSelection: { providerId: "test", modelId: "test" },
      runtimeFeatures: { nodeRepl: true, browserUse: true, computerUse: true },
      subagents: { outputRootDir: directory },
      mcp: { enabled: false },
    },
    {
      eventStore: {
        append: async (event: object) => ({ ...event, sequenceNumber: ++sequence }),
        load: async () => [],
      } as never,
      modelFactory: () => model,
      skillPort,
      browserControlPort: browserPort,
    },
  );
  const original = AgentRuntime.prototype.executeTurn;
  let childId: string | undefined;
  AgentRuntime.prototype.executeTurn = async function () {
    const child = this as unknown as AgentRuntimeInternal;
    childId = child.sessionId;
    assert.equal(child.config.workingDirectory, directory);
    assert.equal(child.config.taskType, "subagent_child");
    assert.equal(child.config.runtimeFeatures?.browserUse, true);
    assert.equal(child.config.runtimeFeatures?.computerUse, undefined);
    assert.ok(this.getToolRegistry().get("js")?.metadata.description.includes("agent.browsers"));
    assert.equal(
      (
        await child.skillPort!.loadSkill({
          name: "browser-use:control-browser",
          workingDirectory: directory,
        })
      ).content,
      "browser instructions",
    );
    await child.browserControlPort!.list({ sessionId: child.sessionId });
    return {
      response: "browser verified",
      events: [],
      traceId: createRootTraceContext().traceId,
    } as never;
  };
  t.after(() => {
    AgentRuntime.prototype.executeTurn = original;
  });
  const result = await (parent as unknown as AgentRuntimeInternal).subagentPort!.run({
    sessionId: parentId,
    agentType: "general-purpose",
    description: "browser regression",
    prompt: "verify browser",
    parentToolCallId: "tool-agent",
    workingDirectory: directory,
    workspaceRoot: directory,
    trace: createRootTraceContext({ sessionId: parentId }),
  });
  assert.equal(result.status, "completed");
  assert.ok(childId);
  assert.deepEqual(closed, [childId]);
  assert.equal(active.size, 0);
  AgentRuntime.prototype.executeTurn = async function () {
    throw new Error("child execution failed");
  };
  await assert.rejects(
    (parent as unknown as AgentRuntimeInternal).subagentPort!.run({
      sessionId: parentId,
      agentType: "general-purpose",
      description: "failed browser child",
      prompt: "fail",
      parentToolCallId: "tool-failed-agent",
      workingDirectory: directory,
      workspaceRoot: directory,
      trace: createRootTraceContext({ sessionId: parentId }),
    }),
    /subagent failed/i,
  );
  assert.equal(closed.length, 2);
  assert.equal(active.size, 0);
  await parent.closeBrowserSession();
});
