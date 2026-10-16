import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProviderAccounts } from "./providerAccounts.js";
import { sdkResponse } from "./providerAccountSdk.fixture.js";
import type { RoutingInvocation } from "@lcode/shared";
for (const protocol of [
  "openai-chat-completions",
  "openai-responses",
  "anthropic-messages",
] as const)
  for (const mode of ["generate", "stream"] as const)
    test(
      "HD-10 real OAuth SDK " +
        protocol +
        " " +
        mode +
        " reserves Token bounds and settles original feedback",
      { timeout: 20000 },
      async (t) => {
        const directory = await mkdtemp(join(tmpdir(), "routing-oauth-sdk-")),
          saved = new Map<string, string>();
        let posts = 0;
        const service: ProviderAccounts = new ProviderAccounts({
          lockPath: join(directory, "accounts"),
          channels: [{ id: "fixture", name: "Fixture" }],
          credentials: {
            load: async (id) => saved.get(id) ?? null,
            save: async (id, value) => {
              saved.set(id, value);
            },
            delete: async (id) => {
              saved.delete(id);
            },
          },
          factory: async () => ({
            routingSingleAttempt: true,
            methods: async () => [{ id: "login", label: "Fixture", type: "oauth" }],
            authorize: async () => ({
              method: "code",
              complete: async () => ({ type: "oauth", access: "synthetic" }),
            }),
            models: async () => [
              {
                id: "model",
                name: "Model",
                protocol,
                baseURL: "https://fixture.invalid/v1",
                routingPortability: "portable",
              },
            ],
            quota: async () => ({
              windows: [
                {
                  id: "tokens",
                  unit: "tokens",
                  remaining: 100,
                  limit: 100,
                  kind: "budget",
                  instanceId: "one",
                  stableId: true,
                },
              ],
            }),
            fetch: async (): Promise<Response> => {
              posts++;
              assert.equal(
                service.readRoutingDiagnostics("fixture")!.owner.resources[0]!.reserved +
                  service.readRoutingDiagnostics("fixture")!.owner.resources[0]!.dispatched,
                60,
              );
              return sdkResponse(protocol, mode === "stream");
            },
          }),
        });
        t.after(async () => {
          await service.dispose();
          await rm(directory, { recursive: true, force: true });
        });
        const login = await service.startAuthorization({ channelId: "fixture", methodId: "login" });
        await service.completeAuthorization(login.attemptId, "fixture");
        const account = (await service.getView()).accounts[0]!;
        await service.getQuota(account.connectionId, true);
        const invocation: RoutingInvocation = {
          capability: "single-attempt-routing-v1",
          createdAt: Date.now(),
          workspaceKey: "workspace",
          sessionId: "session",
          attemptId: "sdk",
          turnId: "turn",
          tokens: { input: 40, output: 20, total: 60, quality: "bound" },
          compatibilityKey: "fixture",
        };
        const auth = await service.resolveRequestAuth(
          "fixture",
          "model",
          protocol,
          "session",
          invocation,
        );
        const child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            resolve("apps/lcode-cli/packages/adapters/src/model/api-key-oauth-sdk.fixture.ts"),
          ],
          { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
        );
        t.after(() => {
          child.kill();
        });
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        child.stdin.end(JSON.stringify({ auth, mode }));
        const code = await new Promise<number | null>((done, reject) => {
          child.once("error", reject);
          child.once("close", done);
        });
        assert.equal(code, 0, stderr);
        assert.equal(JSON.parse(stdout).text, "ok");
        assert.equal(posts, 1);
        const view = service.readRoutingDiagnostics("fixture")!;
        assert.equal(view.owner.resources[0]!.held, 15);
        assert.equal(view.feedback.unresolved, 0);
      },
    );
