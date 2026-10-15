import { app } from "electron";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LCodeAgentProcessManager } from "../../services/src/lcode-agent/lcodeAgentProcessManager.ts";

const [directory, nodeExecutable, backendBundle] = process.argv.slice(2);
async function main() {
  app.setPath("userData", join(directory, "electron-profile"));
  app.disableHardwareAcceleration();
  await app.whenReady();
  const managers = [];
  try {
    const events = [];
    const options = (lane) => ({
      commandResolver: () => ({
        command: nodeExecutable,
        args: [backendBundle, directory, lane],
        cwd: directory,
      }),
      requestTimeoutMs: 15_000,
      processLifecycleReporter: {
        onSpawn: (event) =>
          events.push({ type: "spawn", lane, runtimeInstanceId: event.runtimeInstanceId }),
        onExit: (event) => events.push({ type: "exit", lane, reason: event.terminationReason }),
      },
      ...(lane === "status" ? { lane: "mcp-status", idleTimeoutMs: 25 } : {}),
    });
    const primary = new LCodeAgentProcessManager(options("primary"));
    managers.push(primary);
    const client = await primary.getClient({ workspacePath: directory });
    const query = (action) => client.request("process/childProcesses", action ? { action } : {});
    async function until(predicate) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const state = await query();
        if (predicate(state)) return state;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("Fixture state did not arrive");
    }
    const live = await until((value) => value.readWaiting);
    assert.equal(live.foregroundActive, false);
    assert.equal(live.facts.liveRunCount, 1);
    assert.equal(live.resident, true);
    assert.equal(live.snapshot.status, "running");
    const status = new LCodeAgentProcessManager(options("status"));
    managers.push(status);
    const statusClient = await status.getClient({ workspacePath: directory });
    const retired = new Promise((resolve) =>
      status.onRuntimeLifecycle((event) => {
        if (event.state === "unavailable") resolve();
      }),
    );
    await statusClient.request("process/childProcesses", {});
    await retired;
    await status.disposeAllAndWait();
    assert.equal((await query()).snapshot.status, "running");
    await query("release");
    await until((value) => value.snapshot.runStatus === "completed");
    await query("launch");
    await until((value) => value.readWaiting);
    await primary.disposeWorkspace({ workspacePath: directory });
    const final = JSON.parse(await readFile(join(directory, "primary-result.json"), "utf8"));
    assert.equal(final.snapshot.runStatus, "stopped");
    assert.equal(final.snapshot.stopReason, "interrupted");
    assert.equal(final.close.origin, "stdin_eof");
    assert.ok(
      final.events.some(
        (event) =>
          event.event === "dynamic_workflow.service.closing" &&
          event.closeId === final.close.closeId,
      ),
    );
    await writeFile(
      join(directory, "host-result.json"),
      JSON.stringify({
        passed: true,
        electron: process.versions.electron,
        node: process.versions.node,
        events,
        foregroundCompletedWhileWorkflowLive: true,
        statusLaneIsolated: true,
        explicitCloseInterrupted: true,
      }),
    );
  } catch (error) {
    await writeFile(join(directory, "host-error.txt"), String(error?.stack ?? error));
    process.exitCode = 1;
  } finally {
    await Promise.allSettled(managers.map((manager) => manager.disposeAllAndWait()));
    app.exit(process.exitCode ?? 0);
  }
}
void main().catch((error) => {
  process.stderr.write(String(error?.stack ?? error));
  app.exit(1);
});
