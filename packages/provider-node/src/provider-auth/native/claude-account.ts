import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuthGrant } from "../driver.js";
import type { ClaudeSpawner } from "./claude-process.js";
import { claudeIdentity } from "./identity.js";
import { joinedSignal, record, type Json } from "./common.js";

/** CLI/profile identity only. No OAuth request is made directly to Anthropic. */
export async function identifyClaude(
  grant: AuthGrant,
  dir: string,
  spawn: ClaudeSpawner,
  signal: AbortSignal,
): Promise<AuthGrant> {
  let profile: Json = record(grant.claudeCredentials);
  try {
    profile = {
      ...profile,
      ...record(JSON.parse(await readFile(join(dir, ".claude.json"), "utf8"))),
    };
  } catch {
    /* An import may name its account without a profile. */
  }
  let status: Json = {};
  const bounded = joinedSignal(signal, AbortSignal.timeout(15_000));
  try {
    const child = await spawn(["auth", "status", "--json"], dir);
    const output = await new Promise<string>((resolve) => {
      let out = "",
        size = 0;
      const stop = () => child.kill("SIGKILL");
      bounded.addEventListener("abort", stop, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 262144) stop();
        else out += chunk.toString("utf8");
      });
      child.stderr.resume();
      child.once("error", stop);
      child.once("close", () => {
        bounded.removeEventListener("abort", stop);
        resolve(size > 262144 ? "" : out);
      });
      child.stdin.end();
      if (bounded.aborted) stop();
    });
    try {
      status = record(JSON.parse(output));
    } catch {
      /* Invalid status is not identity evidence. */
    }
  } catch {
    /* The saved profile can still identify an imported account without an installed CLI. */
  }
  signal.throwIfAborted();
  if (status.loggedIn === false) throw new Error("Claude Code reports this account is signed out");
  return claudeIdentity(grant, profile, status);
}
