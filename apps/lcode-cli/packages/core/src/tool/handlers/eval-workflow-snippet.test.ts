import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { HookEventName, SessionEventType } from "@lcode/contracts";
import type { HookRunner } from "../../hooks/index.js";
import { snippetFixture } from "./workflow-snippet-test-fixture.js";

const code = 'log("original fixture"); return { original: true };';
const commandCode = 'return await world.run("node", ["--version"]);';

for (const deliveryKind of ["desktop-continuous", "web-remote-replayable"] as const) {
  for (const path of ["snippet.ts", "missing.ts", "/"]) {
    test(`${deliveryKind} rejects conflicting source ${path} before resolution and execution`, async (t) => {
      const h = await snippetFixture(t, { deliveryKind, mode: "build" });
      await writeFile(join(h.directory, "snippet.ts"), code);
      const result = await h.execute({ code, path, timeoutMs: 5000 });
      assert.equal(result.success, false);
      assert.equal(result.error?.code, "400");
      assert.match(result.modelContent as string, /Both `code` and `path`/);
      assert.match(result.error!.message, /not executed/i);
      assert.match(result.modelContent as string, /REMOVE `path`/);
      assert.match(result.modelContent as string, /REMOVE `code`/);
      assert.ok(result.error!.message.length <= 500);
      assert.deepEqual(h.stages, { resolve: 0, hook: 0, handler: 0 });
      assert.equal(h.requests.length, 0);
      assert.equal(h.approvals.length, 0);
      assert.deepEqual(
        h.events.map((event) => event.type),
        [SessionEventType.ToolCallError],
      );
      const diagnostics = h.debug.filter(
        (item) => item.context?.event === "tool.input.source_rejected",
      );
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0]!.context?.sourceReason, "conflict");
      assert.deepEqual(diagnostics[0]!.context?.schemaRequired, []);
      assert.doesNotMatch(
        JSON.stringify(diagnostics),
        /original fixture|missing\.ts|timeoutMs.*5000/,
      );
    });
  }
}

for (const input of [{}, { timeoutMs: 5000 }]) {
  test(`missing source ${JSON.stringify(input)} is distinct from a conflict`, async (t) => {
    const h = await snippetFixture(t);
    const result = await h.execute(input);
    assert.equal(result.success, false);
    assert.match(result.modelContent as string, /Neither `code` nor `path`/);
    assert.match(result.error!.message, /not executed/i);
    assert.deepEqual(h.stages, { resolve: 0, hook: 0, handler: 0 });
    assert.equal(h.requests.length, 0);
  });
}

for (const input of [
  { code: "" },
  { code: null },
  { path: "" },
  { code, path: null },
  { code, timeoutMs: 999 },
  { code, timeoutMs: 600001 },
  { code, unknown: true },
]) {
  test(`invalid field ${JSON.stringify(input)} retains initial schema rejection`, async (t) => {
    const h = await snippetFixture(t);
    const result = await h.execute(input);
    assert.equal(result.success, false);
    assert.deepEqual(h.stages, { resolve: 0, hook: 0, handler: 0 });
    assert.equal(h.requests.length, 0);
    assert.equal(
      h.debug.some((item) => item.context?.event === "tool.input.source_rejected"),
      false,
    );
  });
}

test("inline correction preserves code and timeout and closes each call once", async (t) => {
  const h = await snippetFixture(t);
  for (const id of ["bad-1", "bad-2"]) {
    assert.equal((await h.execute({ code, path: "/" }, id)).success, false);
  }
  assert.equal(h.requests.length, 0);
  const result = await h.execute({ code, timeoutMs: 5000 }, "corrected");
  assert.equal(result.success, true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0]!.code, code);
  assert.equal(h.requests[0]!.timeoutMs, 5000);
  for (const id of ["bad-1", "bad-2", "corrected"]) {
    const terminal = h.events.filter(
      (event) =>
        (event.type === SessionEventType.ToolCallError ||
          event.type === SessionEventType.ToolCallResult) &&
        (event.payload as { toolCallId: string }).toolCallId === id,
    );
    assert.equal(terminal.length, 1);
  }
  assert.equal(result.backgroundTaskId, undefined);
});

test("omitted timeout uses the existing default", async (t) => {
  const h = await snippetFixture(t);
  assert.equal((await h.execute({ code })).success, true);
  assert.equal(h.requests[0]!.timeoutMs, 60000);
});

test("registry exposes the same optional schema and diagnostics do not depend on input values", async (t) => {
  const h = await snippetFixture(t);
  const contract = h.registry.toContracts().find((item) => item.name === "EvalWorkflowSnippet")!;
  assert.deepEqual(contract.inputSchema!.required, []);
  const original = structuredClone(contract.inputSchema);
  await h.execute({ code, path: "private-fixture-path" }, "first");
  await h.execute({ code: "return 2;", path: "other-fixture-path" }, "second");
  const records = h.debug.filter((item) => item.context?.event === "tool.input.source_rejected");
  assert.equal(records.length, 2);
  assert.equal(records[0]!.context?.schemaFingerprint, records[1]!.context?.schemaFingerprint);
  assert.doesNotMatch(
    JSON.stringify(records),
    /private-fixture-path|other-fixture-path|return 2|original fixture/,
  );
  assert.deepEqual(contract.inputSchema, original);
});

for (const path of ["missing.ts", "."]) {
  test(`unreadable ${path} guides a code source without executing`, async (t) => {
    const h = await snippetFixture(t);
    const result = await h.execute({ path });
    assert.equal(result.success, false);
    assert.match(result.modelContent as string, /not executed/i);
    assert.match(result.modelContent as string, /omit `path`.*`code`/);
    assert.equal(h.stages.resolve, 1);
    assert.equal(h.stages.hook, 0);
    assert.equal(h.requests.length, 0);
  });
}

for (const hookEventName of [HookEventName.PreToolUse, HookEventName.PermissionRequest]) {
  test(`file bytes survive ${hookEventName} and approval without a second read`, async (t) => {
    const h = await snippetFixture(t, {
      mode: "build",
      afterResolution: async (_input, directory) => {
        await writeFile(join(directory, "snippet.ts"), 'return "changed";');
      },
      hookRunner: {
        run: async (event) =>
          event.hookEventName !== hookEventName
            ? { additionalContexts: [] }
            : hookEventName === HookEventName.PreToolUse
              ? { additionalContexts: [], updatedInput: event.toolInput }
              : {
                  additionalContexts: [],
                  permissionRequestResult: { behavior: "ask", updatedInput: event.toolInput },
                },
      } as HookRunner,
      answer: (request) => ({ decision: "modify", modifiedInput: request.input }),
    });
    const path = join(h.directory, "snippet.ts");
    const original = `/* lcode-workflow\nfixture-only comment\n*/\n${commandCode}`;
    await writeFile(path, original);
    const result = await h.execute({ path: "snippet.ts" });
    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.equal(h.approvals.length, 1);
    assert.deepEqual(h.approvals[0]!.input, { code: original, path });
    assert.equal(h.requests[0]!.code, original);
    assert.equal(await readFile(path, "utf8"), 'return "changed";');
    assert.equal(h.stages.resolve, 1);
  });
}

test("default build permissions ask only for a compiled world.run", async (t) => {
  const h = await snippetFixture(t, { mode: "build" });
  assert.equal((await h.execute({ code }, "read")).success, true);
  assert.equal(h.approvals.length, 0);
  assert.equal((await h.execute({ code: commandCode }, "command")).success, true);
  assert.equal(h.approvals.length, 1);
});

test("runtime failure retains executed logs and does not claim nothing ran", async (t) => {
  const h = await snippetFixture(t, {
    result: {
      kind: "failed",
      error: { code: "DriverError", message: "fixture failed" },
      logs: ["already executed"],
      logsTruncated: false,
    },
  });
  const result = await h.execute({ code });
  assert.match(result.modelContent as string, /fixture failed/);
  assert.match(result.modelContent as string, /already executed/);
  assert.doesNotMatch(result.modelContent as string, /not executed/i);
});
