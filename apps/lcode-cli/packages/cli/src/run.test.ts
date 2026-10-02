import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Logger, SessionEvent } from "@lcode/contracts";
import type { RunContext } from "@lcode/shared-types";
import { run } from "./run.js";
import { runPrompt } from "./prompt-command.js";
import type { RunDependencies } from "./cli-types.js";

function fixture(argv: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const context = {
    argv,
    stdin: {},
    stdout: { write: (text: string) => stdout.push(text) },
    stderr: { write: (text: string) => stderr.push(text) },
  } as unknown as RunContext;
  const shutdownProcess = Object.assign(new EventEmitter(), { platform: process.platform });
  const calls: string[] = [];
  let observedOptions: Parameters<NonNullable<RunDependencies["createLCodeApp"]>>[0];
  let submitted: unknown;
  let submitOptions: unknown;
  let onEvent: ((event: SessionEvent) => void) | undefined;
  const result = {
    response: "fixture response",
    events: [],
    turnId: "turn-fixture",
    projection: { status: "idle", turnCount: 1, totalTokenCount: 4 },
  };
  const app = {
    traceId: "trace-fixture",
    sessionId: "session-fixture",
    runtime: {
      subscribeEvents: (sink: { onSessionEvent: (event: SessionEvent) => void }) => {
        calls.push("subscribe");
        onEvent = sink.onSessionEvent;
        return () => calls.push("detach");
      },
    },
    submitPrompt: async (prompt: unknown, options: unknown) => {
      calls.push("submit");
      submitted = prompt;
      submitOptions = options;
      onEvent?.({ type: "fixture_event" } as unknown as SessionEvent);
      return result;
    },
    close: async () => {
      calls.push("app.close");
    },
  };
  const logger: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child: () => logger,
  };
  const deps: RunDependencies = {
    logger,
    env: { LCODE_RUNTIME_ENV: "production" },
    cwd: () => process.cwd(),
    skipUserConfig: true,
    shutdownProcess,
    loadDotenv: () => ({ loaded: false, keys: [] }),
    createLCodeApp: async (options) => {
      observedOptions = options;
      return app as unknown as Awaited<ReturnType<NonNullable<RunDependencies["createLCodeApp"]>>>;
    },
    mapSessionEvent: ((event: SessionEvent) => ({
      type: event.type,
    })) as unknown as RunDependencies["mapSessionEvent"],
    startProcessProviderRegistryRuntime: async () =>
      ({
        runtime: { registryService: {} },
        dispose: () => {
          calls.push("registry.dispose");
        },
      }) as unknown as Awaited<
        ReturnType<NonNullable<RunDependencies["startProcessProviderRegistryRuntime"]>>
      >,
    prepareLCodeTelemetryEnv: async (env) => env ?? {},
    shutdownLCodeTelemetry: async () => {
      calls.push("telemetry.shutdown");
    },
  };
  return {
    context,
    deps,
    stdout,
    stderr,
    calls,
    shutdownProcess,
    options: () => observedOptions,
    prompt: () => submitted,
    submitOptions: () => submitOptions as { onEvent?: unknown },
  };
}

test("CLI entrypoints retain callable arity", () => {
  assert.equal(run.length, 1);
  assert.equal(runPrompt.length, 7);
});

test("CLI flag validation precedes app creation", async () => {
  const cases: Array<[string[], string]> = [
    [["--output-format", "invalid"], "--output-format must be one of"],
    [["--target-replace"], "--target-replace requires --target"],
    [["--target", " "], "--target requires non-empty text"],
    [["--target", "objective", "--prompt", "prompt"], "--target cannot be used with --prompt"],
    [["doctor", "--force-mcs"], "--force-mcs can only be used"],
    [["--browser-executable", "fixture"], "--browser-executable requires"],
    [["doctor", "--browser-use=headless"], "--browser-use=headless can only be used"],
    [["doctor", "--surface", "desktop"], "--surface can only be used"],
    [["doctor", "--memory-bench"], "--memory-bench can only be used"],
    [
      ["--continue", "--resume", "session-fixture"],
      "--resume and --continue cannot be used together",
    ],
  ];
  for (const [argv, message] of cases) {
    const f = fixture(argv);
    assert.equal(await run(f.context, f.deps), 1, argv.join(" "));
    assert.ok(f.stderr.join("").includes(message), f.stderr.join(""));
    assert.deepEqual(f.calls, []);
  }
});

test("prompt output keeps a single event writer and detaches before cleanup", async () => {
  const f = fixture(["--prompt", "fixture", "--output-format", "stream-json"]);
  assert.equal(await run(f.context, f.deps), 0, f.stderr.join(""));
  assert.equal(f.prompt(), "fixture");
  assert.equal(f.options()?.runtimeConfig?.mode, "yolo");
  assert.equal(f.submitOptions().onEvent, undefined);
  const lines = f.stdout
    .join("")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].type, "fixture_event");
  assert.equal(lines[1].type, "result");
  assert.equal(lines[1].response, "fixture response");
  assert.equal("turnResponses" in lines[1], false);
  assert.deepEqual(f.calls, [
    "subscribe",
    "submit",
    "detach",
    "app.close",
    "telemetry.shutdown",
    "registry.dispose",
  ]);
  assert.equal(f.shutdownProcess.listenerCount("SIGINT"), 0);
});

test("explicit text output wins over json and keeps attachment type inference", async () => {
  const f = fixture([
    "--prompt",
    "fixture",
    "--json",
    "--output-format",
    "text",
    "--attach",
    "image.PNG",
    "--attach",
    "clip.MP4",
    "--attach",
    "document.PDF",
    "--attach",
    "note.txt",
  ]);
  assert.equal(await run(f.context, f.deps), 0, f.stderr.join(""));
  assert.equal(f.stdout.join(""), "fixture response\n");
  assert.deepEqual(f.prompt(), {
    text: "fixture",
    attachments: [
      { type: "image", path: "image.PNG" },
      { type: "video", path: "clip.MP4" },
      { type: "pdf", path: "document.PDF" },
      { type: "file", path: "note.txt" },
    ],
  });
});

test("protocol command skips production dotenv and sanitizes injected environment", async () => {
  const f = fixture(["app-server", "--surface", "desktop", "--prepare-storage"]);
  let observed: Parameters<NonNullable<RunDependencies["runLCodeProtocolAgent"]>>[0];
  f.deps.env = { LCODE_RUNTIME_ENV: "production", LCODE_CUA_PLUGIN_AUTHORITY: "fixture-authority" };
  f.deps.loadDotenv = () => {
    throw new Error("production must not read dotenv");
  };
  f.deps.runLCodeProtocolAgent = async (options) => {
    observed = options;
  };
  assert.equal(await run(f.context, f.deps), 0, f.stderr.join(""));
  assert.equal(observed?.presentationSurface, "lcode_desktop");
  assert.equal(observed?.prepareStorageOnly, true);
  assert.equal(observed?.env?.LCODE_CUA_PLUGIN_AUTHORITY, undefined);
});
