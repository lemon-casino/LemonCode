import { spawn } from "node:child_process";

/** Owns only this spawned process/group. Byte bounds precede buffering and UTF-8 decoding. */
export function runProcess(
  command,
  args,
  { cwd, env, timeoutMs, maxOutputBytes, signal, cleanupGraceMs = 1000, spawnProcess = spawn },
) {
  return new Promise((resolve) => {
    const output = { stdout: [], stderr: [] };
    let bytes = 0,
      reason,
      done = false,
      exited = false,
      cleanupTimer,
      killerCompletion;
    const child = spawnProcess(command, args, {
      cwd,
      env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const cleanupDeadline = () => {
      if (cleanupTimer) return;
      cleanupTimer = setTimeout(
        () => {
          reason = "cleanup_unconfirmed";
          // Parent exit can orphan Windows descendants; never discover global PIDs to guess ownership.
          if (process.platform !== "win32" && child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              /* group already gone */
            }
          }
          child.stdout.destroy();
          child.stderr.destroy();
          // Stop only the known child and detach handles if termination cannot be confirmed.
          if (!exited) {
            try {
              child.kill?.("SIGKILL");
            } catch {
              /* best effort only */
            }
          }
          child.unref?.();
          finish(null, undefined, false);
        },
        Math.max(1, cleanupGraceMs),
      );
    };
    const stop = (value) => {
      if (done || reason) return;
      reason = value;
      cleanupDeadline();
      if (!child.pid || exited) return;
      if (process.platform === "win32") {
        killerCompletion = new Promise((resolveKilled) => {
          const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
          killer.on("error", () => {
            child.kill();
            resolveKilled(false);
          });
          killer.on("close", (code) => resolveKilled(code === 0));
        });
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
          killerCompletion = Promise.resolve(true);
        } catch {
          child.kill("SIGKILL");
          killerCompletion = Promise.resolve(false);
        }
      }
    };
    const onAbort = () => stop("cancelled");
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    for (const [stream, key] of [
      [child.stdout, "stdout"],
      [child.stderr, "stderr"],
    ])
      stream.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxOutputBytes) {
          stop("output_limit");
          return;
        }
        output[key].push(Buffer.from(chunk));
      });
    const finish = (code, error, cleanupConfirmed = null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        code,
        stdout: Buffer.concat(output.stdout).toString("utf8"),
        stderr: Buffer.concat(output.stderr).toString("utf8"),
        reason: reason ?? (error ? "spawn_error" : undefined),
        cleanupConfirmed,
      });
    };
    child.on("error", (error) => finish(null, error));
    child.on("exit", () => {
      exited = true;
      cleanupDeadline();
    });
    child.on("close", async (code) => {
      if (reason) {
        const confirmed = await (killerCompletion ?? Promise.resolve(false));
        if (!confirmed) reason = "cleanup_unconfirmed";
        finish(code, undefined, confirmed);
      } else finish(code);
    });
  });
}
