import { readFile, writeFile, chmod } from "node:fs/promises";
import { watch } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { AuthChallenge, AuthGrant } from "../driver.js";
import { joinedSignal } from "./common.js";
import { identifyClaude } from "./claude-account.js";
import {
  claudeGrant,
  readClaudeCredentials,
  removeClaudeProfile,
  spawnClaude,
  temporaryClaudeProfile,
  type ClaudeSpawner,
} from "./claude-process.js";

/** Claude Code itself owns its browser flow and token exchange; no direct Anthropic OAuth emulation. */
export async function authorizeClaude(
  signal: AbortSignal,
  spawn: ClaudeSpawner = spawnClaude,
): Promise<AuthChallenge> {
  signal.throwIfAborted();
  const dir = await temporaryClaudeProfile();
  const controller = new AbortController();
  signal = joinedSignal(signal, controller.signal, AbortSignal.timeout(10 * 60_000));
  const marker = join(dir, "opened-url");
  const helper = join(dir, "open-url.cjs");
  const launcher = join(dir, process.platform === "win32" ? "open-url.cmd" : "open-url");
  await writeFile(
    helper,
    `const fs = require('node:fs/promises'); fs.writeFile(${JSON.stringify(marker)}, process.argv[2] || '', {mode:384}).catch(() => process.exitCode=1);`,
    { mode: 0o600 },
  );
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(
    launcher,
    process.platform === "win32"
      ? `@"${process.execPath}" "${helper}" %*\r\n`
      : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(helper)} "$@"\n`,
    { mode: 0o700 },
  );
  if (process.platform !== "win32") await chmod(launcher, 0o700);
  let resolve!: (grant: AuthGrant) => void;
  let reject!: (error: Error) => void;
  let linkResolve!: (url: string) => void;
  const done = new Promise<AuthGrant>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void done.catch(() => {});
  const link = new Promise<string>((yes) => {
    linkResolve = yes;
  });
  let browserURL = "";
  let settled = false;
  const takeURL = (raw: string) => {
    for (const match of stripVTControlCharacters(raw).matchAll(/https:\/\/[^\s<>"']+/g)) {
      try {
        const url = new URL(match[0]);
        if (!["claude.ai", "console.anthropic.com", "platform.claude.com"].includes(url.hostname))
          continue;
        browserURL = url.href;
        linkResolve(browserURL);
        return;
      } catch {
        /* CLI output that is not an authorization URL. */
      }
    }
  };
  const watcher = watch(dir, (_event, file) => {
    if (file?.toString() === "opened-url")
      void readFile(marker, "utf8")
        .then(takeURL)
        .catch(() => {});
  });
  let child: Awaited<ReturnType<ClaudeSpawner>>;
  try {
    child = await spawn(["auth", "login", "--claudeai"], dir, { BROWSER: launcher });
  } catch (error) {
    watcher.close();
    await removeClaudeProfile(dir);
    throw error;
  }
  const closed = new Promise<void>((resolve) => {
    child.once("close", resolve);
  });
  const abort = () => {
    child.kill();
    if (!settled) reject(new Error("Claude authorization cancelled"));
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output = (output + chunk.toString("utf8")).slice(-32_768);
    takeURL(output);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    takeURL(chunk.toString("utf8"));
  });
  child.once("error", () => {
    reject(new Error("Claude Code CLI is unavailable; install it or set LCODE_CLAUDE_BIN"));
  });
  child.once("close", (code) => {
    void (async () => {
      let grant: AuthGrant | undefined;
      let failure: Error | undefined;
      try {
        signal.throwIfAborted();
        if (code !== 0) throw new Error("Claude Code authorization failed");
        grant = await identifyClaude(
          claudeGrant(await readClaudeCredentials(dir)),
          dir,
          spawn,
          signal,
        );
      } catch (error) {
        failure = error instanceof Error ? error : new Error("Claude authorization failed");
      } finally {
        settled = true;
        watcher.close();
        signal.removeEventListener("abort", abort);
        try {
          await removeClaudeProfile(dir);
        } catch {
          failure = new Error("Cannot remove Claude's temporary authorization profile");
        }
      }
      if (failure) reject(failure);
      else if (grant) resolve(grant);
    })();
  });
  try {
    await Promise.race([link, done]);
  } catch (error) {
    abort();
    watcher.close();
    signal.removeEventListener("abort", abort);
    await closed;
    await removeClaudeProfile(dir).catch(() => {});
    throw error;
  }
  return {
    url: browserURL || undefined,
    method: "auto",
    instructions:
      "Complete Claude Code sign-in in your browser. You can paste its code#state or callback URL.",
    cancel: () => controller.abort(),
    async complete(value) {
      signal.throwIfAborted();
      if (value && !settled) {
        if (/^https?:\/\//.test(value)) {
          const auth = new URL(browserURL);
          const expected = auth.searchParams.get("redirect_uri");
          if (!expected)
            throw new Error("Claude did not provide a callback address; paste code#state instead");
          const callback = new URL(value);
          const target = new URL(expected);
          if (
            callback.origin !== target.origin ||
            callback.pathname !== target.pathname ||
            !["localhost", "127.0.0.1"].includes(callback.hostname) ||
            !callback.searchParams.get("code") ||
            callback.searchParams.get("state") !== auth.searchParams.get("state")
          )
            throw new Error("Invalid Claude callback address");
          const response = await fetch(callback, { signal, redirect: "error" });
          await response.body?.cancel();
          if (!response.ok) throw new Error("Claude Code rejected the callback");
        } else {
          if (!/^[^\s#]+#[^\s#]+$/.test(value))
            throw new Error("Paste Claude's code#state or its full callback URL");
          child.stdin.write(value + "\n");
        }
      }
      return done;
    },
  };
}
