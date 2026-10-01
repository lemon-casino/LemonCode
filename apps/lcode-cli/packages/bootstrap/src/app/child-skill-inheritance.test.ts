import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNodeSkillAdapter } from "@lcode/adapters/skills";
import { createInMemorySessionEventStore } from "@lcode/adapters/storage";
import { createRootTraceContext, createSessionId, type SkillPort } from "@lcode/contracts";
import { AgentRuntime } from "@lcode/core";
import {
  createScriptWorkflowAgentRuntime,
  type ScriptWorkflowAgentRuntimeDeps,
} from "./script-workflow-child-runtime.js";

test("workflow actors inherit enabled plugin roots and disabled paths from the parent skill port", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-child-skills-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plugin = join(directory, "browser-use");
  const skillDirectory = join(plugin, "skills", "control-browser");
  const skillPath = join(skillDirectory, "SKILL.md");
  await mkdir(skillDirectory, { recursive: true });
  await mkdir(join(plugin, ".lcode-plugin"));
  await writeFile(
    join(plugin, ".lcode-plugin", "plugin.json"),
    JSON.stringify({ name: "browser-use" }),
  );
  await writeFile(
    skillPath,
    "---\nname: control-browser\ndescription: Control a real browser\n---\nBrowser instructions\n",
  );
  const roots = [
    {
      path: join(plugin, "skills"),
      source: "plugin" as const,
      scope: "user" as const,
      priority: 100,
      pluginId: "browser-use@test",
    },
  ];
  const effective = createNodeSkillAdapter({ extraResolvedRoots: roots });
  assert.equal(
    (
      await effective.loadSkill({
        name: "browser-use:control-browser",
        workingDirectory: directory,
      })
    ).content,
    "Browser instructions",
  );

  const createChild = (skillPort: SkillPort) => {
    const eventStore = createInMemorySessionEventStore();
    const parentId = createSessionId("parent");
    const runtimeConfig = {
      workingDirectory: directory,
      subagents: { enabled: false },
      mcp: { enabled: false },
    };
    const parent = new AgentRuntime(parentId, runtimeConfig, {
      eventStore,
      skillPort,
      modelFactory: () => {
        throw new Error("No model calls expected");
      },
    });
    const deps = {
      agentTelemetry: { captureCausation: () => undefined },
      appOptions: { executionPort: {}, fileSystemPort: {} },
      configResult: {
        config: {
          features: { skill: true },
          skills: { enabled: true, roots: [] },
          network: {},
          skillOverrides: {},
        },
      },
      runtime: parent,
      runtimeConfig,
      sessionId: parentId,
      eventStore,
      workingDirectory: directory,
      storageRoot: directory,
      skillPort,
    } as unknown as ScriptWorkflowAgentRuntimeDeps;
    const childId = createSessionId(`child-${Math.random()}`);
    return createScriptWorkflowAgentRuntime({
      childSessionId: childId,
      deps,
      request: { opts: {} } as never,
      traceContext: createRootTraceContext({ sessionId: childId }),
    });
  };
  const child = createChild(effective);
  const catalog = await child.getSkillCatalog(createRootTraceContext());
  assert.ok(catalog.skills.some((s) => s.qualifiedName === "browser-use:control-browser"));
  await child.closeBrowserSession();

  const disabled = createNodeSkillAdapter({
    extraResolvedRoots: roots,
    disabledPaths: [skillPath],
  });
  const disabledChild = createChild(disabled);
  assert.equal(
    (await disabledChild.getSkillCatalog(createRootTraceContext())).skills.some(
      (s) => s.qualifiedName === "browser-use:control-browser",
    ),
    false,
  );
  await disabledChild.closeBrowserSession();
});
