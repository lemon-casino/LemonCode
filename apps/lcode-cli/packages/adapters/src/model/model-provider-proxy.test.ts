import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { parseProviderConfig, createRegistryProviderConfig, type ProviderConfigObject } from "@lcode/provider";
import { AiSdkModelExecution } from "./model-execution.js";

test("formal API model requests select default, direct and authenticated custom proxy without stale routing", async (t) => {
  const visits: string[] = [];
  const servers: Array<ReturnType<typeof createServer>> = [];
  const listen = async (name: string) => {
    const server = createServer((req, res) => {
      visits.push(name);
      if (name === "custom") assert.equal(req.headers["proxy-authorization"], `Basic ${Buffer.from("fixture@user:p:a@ss%").toString("base64")}`);
      if (name === "direct") assert.equal(req.headers["proxy-authorization"], undefined);
      req.resume();
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "fixture", choices: [{ message: { role: "assistant", content: name }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
    servers.push(server);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address !== "string");
    return `http://127.0.0.1:${address.port}`;
  };
  t.after(() => { for (const server of servers) { server.closeAllConnections(); server.close(); } });
  const target = await listen("direct"), defaults = await listen("default"), custom = await listen("custom");
  const execution = new AiSdkModelExecution({ network: { httpProxy: defaults }, env: { LCODE_HTTP_PROXY: "http://invalid.example:7890", LCODE_TOOL_ENV_PASSTHROUGH_JSON: JSON.stringify({ HTTPS_PROXY: "http://invalid.example:7890" }) } });
  for (const network of [undefined, { mode: "direct" }, { mode: "custom", httpProxy: custom.replace("http://", "http://fixture%40user:p%3Aa%40ss%25@") }] as const) {
    const provider = createRegistryProviderConfig(parseProviderConfig({ group: "standard-personal", api: { type: "openai-chat-completions", baseUrl: target }, access: { type: "api-key", apiKey: "fixture-model-key" }, network: network as ProviderConfigObject["network"] }));
    assert.ok(provider.ok);
    const bound = execution.bindModel({ providerId: "same-provider", modelId: "fixture-model", providerConfig: provider.config, supportsJsonSchemaOutput: false, optionSpecs: { reasoningLevel: { map: "{}" }, maxOutputTokens: { map: "{}" } } });
    const resolved = bound.resolveRequest({ options: { reasoningLevel: "low", maxOutputTokens: 8 } });
    await (resolved.model as unknown as { doGenerate(options: unknown): Promise<unknown> }).doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "fixture" }] }], maxOutputTokens: 8 });
  }
  assert.deepEqual(visits, ["default", "direct", "custom"]);
});
