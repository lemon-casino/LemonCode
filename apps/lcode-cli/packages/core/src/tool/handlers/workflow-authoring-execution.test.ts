import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  WorkflowEngine,
  InMemoryJournalStore,
  buildAskSpecs,
  collectDiagnostics,
  collectSites,
  createWorkflowProgram,
  lowerWorkflow,
  synthesizeAskSchemas,
  validate,
  type AskMessage,
  type InstanceRef,
  type WorkflowDriver,
} from "@lcode/dynamic-workflow";

const SKILL_URL = new URL(
  "../../../../lemon-workflow-plugin/skills/dynamic-workflows/SKILL.md",
  import.meta.url,
);
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function boundedExample(): Promise<string> {
  const skill = await readFile(SKILL_URL, "utf8");
  const match = skill.match(/<!-- bounded-delivery-example -->\s*```ts\r?\n([\s\S]*?)\r?\n```/u);
  assert.ok(match, "the built-in skill must carry the executable bounded-delivery example");
  return match[1]!;
}

function execute(source: string, maxConcurrency: number) {
  const program = createWorkflowProgram(source);
  assert.deepEqual(collectDiagnostics(program.program), []);
  const table = collectSites(program);
  const synthesis = synthesizeAskSchemas(program, table);
  assert.deepEqual(synthesis.diagnostics, []);
  const journal = new InMemoryJournalStore();
  const started: Array<{ instance: InstanceRef; message: AskMessage }> = [];
  const writes: string[] = [];
  const commands: string[][] = [];
  const driver: WorkflowDriver = {
    journal,
    emit: () => {},
    createActorSession: async (actor) => ({ id: `${actor.siteId}@${actor.ordinal}` }),
    startAsk: (_session, instance, message) => {
      started.push({ instance, message });
    },
    respondToSubmit: () => {},
    cancelAsk: () => {},
    executeWorldRead: async (_op, args) => {
      commands.push(args as string[]);
      return { exitCode: 0, stdout: "checked", stderr: "" };
    },
  };
  const engine = new WorkflowEngine({
    runId: "bounded-example",
    driver,
    caps: { maxConcurrency },
    askSpecs: buildAskSpecs(table, synthesis.schemas),
    validate,
  });
  // 只执行本仓库 skill 的降级代码；真实引擎 + 内存 journal，driver 不调模型、不写磁盘。
  const run = runInNewContext(`(async (__host) => { ${lowerWorkflow(program, table).code} })`) as (
    host: WorkflowEngine,
  ) => Promise<unknown>;
  const result = run(engine);
  const queued = () =>
    journal
      .listNodes("bounded-example")
      .filter((node) => node.kind === "ask")
      .map((node) => node.siteId);
  const complete = async (siteId: string, value: unknown, allowedWrites: string[] = []) => {
    const active = started.find((item) => item.instance.siteId === siteId);
    assert.ok(active, `${siteId} has not started`);
    writes.push(...allowedWrites);
    if (active.message.typed) engine.askSubmitAttempted(active.instance, value);
    engine.askTurnEnded(active.instance, typeof value === "string" ? value : JSON.stringify(value));
    await flush();
  };
  return { engine, result, queued, started, complete, writes, commands };
}

for (const cap of [1, 2]) {
  test(`bounded example enqueues independent UI investigation before service delivery (cap=${cap})`, async () => {
    const execution = execute(await boundedExample(), cap);
    const { engine, complete, queued, started, result, commands, writes } = execution;
    try {
      await flush();
      assert.deepEqual(queued(), ["ask#1", "ask#2"]);
      assert.equal(started.length, cap);
      assert.deepEqual(writes, []);
      assert.equal(
        queued().includes("ask#3"),
        false,
        "contract writer waits for both investigations",
      );
      await complete("ask#1", {
        conclusion: "service facts",
        evidence: ["src/service.ts"],
        blockers: [],
      });
      assert.deepEqual(queued(), ["ask#1", "ask#2"]);
      await complete("ask#2", { conclusion: "UI facts", evidence: ["src/ui.ts"], blockers: [] });
      assert.deepEqual(queued(), ["ask#1", "ask#2", "ask#3"]);
      await complete("ask#3", { ready: true, contractPath: "src/contract.ts", blockers: [] }, [
        "src/contract.ts",
      ]);
      assert.deepEqual(queued(), ["ask#1", "ask#2", "ask#3", "ask#4", "ask#5"]);
      assert.equal(
        commands.length,
        1,
        "baseline alone ran; final acceptance waits for both writes",
      );
      await complete("ask#4", "service slice checked", ["src/service.ts"]);
      assert.equal(commands.length, 1);
      await complete("ask#5", "UI slice checked", ["src/ui.ts"]);
      await result;
      assert.equal(commands.length, 2, "final acceptance runs once after both slices");
      assert.deepEqual(writes, ["src/contract.ts", "src/service.ts", "src/ui.ts"]);
    } finally {
      void result.catch(() => {});
      engine.stop("user");
      await engine.settled;
    }
  });
}

test("a blocked contract never enqueues dependent implementations", async () => {
  const { engine, result, complete, queued, writes, commands } = execute(await boundedExample(), 2);
  try {
    await flush();
    await complete("ask#1", {
      conclusion: "service facts",
      evidence: ["src/service.ts"],
      blockers: [],
    });
    await complete("ask#2", { conclusion: "UI facts", evidence: ["src/ui.ts"], blockers: [] });
    await complete("ask#3", {
      ready: false,
      contractPath: "",
      blockers: ["permission owner unresolved"],
    });
    await result;
    assert.deepEqual(queued(), ["ask#1", "ask#2", "ask#3"]);
    assert.deepEqual(writes, []);
    assert.equal(commands.length, 1);
  } finally {
    void result.catch(() => {});
    engine.stop("user");
    await engine.settled;
  }
});

test("enqueued asks on the same actor remain FIFO even with free slots", async () => {
  const { engine, result, started, queued, complete } = execute(
    `
phase("Use one shared context");
const reviewer = agent("Calibrated reviewer");
const first = reviewer.ask("Read the contract");
const second = reviewer.ask("Use the previous context");
return await Promise.all([first, second]);`,
    2,
  );
  try {
    await flush();
    assert.deepEqual(queued(), ["ask#1", "ask#2"]);
    assert.equal(started.length, 1);
    await complete("ask#1", "contract");
    assert.equal(started.length, 2);
    await complete("ask#2", "consistent check");
    assert.deepEqual(Array.from((await result) as string[]), ["contract", "consistent check"]);
  } finally {
    void result.catch(() => {});
    engine.stop("user");
    await engine.settled;
  }
});
