import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ZCODE_CUA_OFFICIAL_PLUGIN_ID, ZCODE_PLUGIN_ID_ENV_KEY } from "@zcode/shared/mcp";
import {
  resetCapturedZCodeCuaBrokerCredentialsForTest,
  sanitizeZCodeRuntimeEnvInPlace,
  ZCODE_CUA_BROKER_SOCKET_ENV_KEY,
  ZCODE_CUA_NODE_REPL_HOST_ENV_KEY,
  ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
} from "@zcode/shared/runtime-env";
import type { RunContext } from "@zcode/shared-types";
import { runPluginHostCommand } from "./plugin-host-command.js";

const REFRESH_MARKER_ENV = "ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER";
const GENERATION_ENV = "ZCODE_CUA_PERMISSION_BROKER_GENERATION";
const OUTPUT_ENV = "ZCODE_PLUGIN_HOST_TEST_OUTPUT";

const ENV_KEYS = [
  ZCODE_CUA_BROKER_SOCKET_ENV_KEY,
  ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  REFRESH_MARKER_ENV,
  GENERATION_ENV,
  ZCODE_CUA_NODE_REPL_HOST_ENV_KEY,
  ZCODE_PLUGIN_ID_ENV_KEY,
  OUTPUT_ENV,
] as const;

test("trusted node_repl host restores the complete captured CUA tuple only for main()", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-cua-plugin-host-"));
  const outputPath = join(directory, "observed.json");
  const serverPath = join(directory, "server.mjs");
  const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  let stderr = "";
  try {
    await writeFile(
      serverPath,
      `import { writeFile } from "node:fs/promises";
export async function main() {
  const keys = ${JSON.stringify([
    ZCODE_CUA_BROKER_SOCKET_ENV_KEY,
    ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
    REFRESH_MARKER_ENV,
    GENERATION_ENV,
  ])};
  await writeFile(process.env.${OUTPUT_ENV}, JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key]]))));
}
`,
    );
    process.env[ZCODE_CUA_BROKER_SOCKET_ENV_KEY] = "\\\\.\\pipe\\zcode-cua-test";
    process.env[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY] = "test-authority";
    process.env[REFRESH_MARKER_ENV] = "C:\\test\\refresh.marker";
    process.env[GENERATION_ENV] = "7";
    sanitizeZCodeRuntimeEnvInPlace(process.env);
    assert.equal(process.env[ZCODE_CUA_BROKER_SOCKET_ENV_KEY], undefined);
    assert.equal(process.env[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY], undefined);
    assert.equal(process.env[REFRESH_MARKER_ENV], undefined);

    process.env[ZCODE_CUA_NODE_REPL_HOST_ENV_KEY] = "1";
    process.env[ZCODE_PLUGIN_ID_ENV_KEY] = ZCODE_CUA_OFFICIAL_PLUGIN_ID;
    process.env[OUTPUT_ENV] = outputPath;
    const exitCode = await runPluginHostCommand(
      {
        stderr: { write: (value: unknown) => void (stderr += String(value)) },
      } as unknown as RunContext,
      [serverPath],
    );

    assert.equal(exitCode, 0, stderr);
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), {
      [ZCODE_CUA_BROKER_SOCKET_ENV_KEY]: "\\\\.\\pipe\\zcode-cua-test",
      [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: "test-authority",
      [REFRESH_MARKER_ENV]: "C:\\test\\refresh.marker",
      [GENERATION_ENV]: "7",
    });
    assert.equal(process.env[ZCODE_CUA_BROKER_SOCKET_ENV_KEY], undefined);
    assert.equal(process.env[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY], undefined);
    assert.equal(process.env[REFRESH_MARKER_ENV], undefined);
  } finally {
    resetCapturedZCodeCuaBrokerCredentialsForTest();
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
