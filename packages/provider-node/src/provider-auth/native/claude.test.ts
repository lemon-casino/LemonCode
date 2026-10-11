import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuthDriverContext, AuthGrant } from "../driver.js";
import { ClaudeAuthDriver } from "./claude.js";
import { claudeEnvironment, claudeGrant } from "./claude-process.js";
import type { ClaudeSpawner } from "./claude-session.js";
import { record, list } from "./common.js";

const fixture = `
import readline from 'node:readline';
import { writeFile } from 'node:fs/promises';
const args = process.argv.slice(1);
const emit = event => process.stdout.write(JSON.stringify({type:'stream_event',event})+'\\n');
const start = id => emit({type:'message_start',message:{id,type:'message',role:'assistant',content:[],model:'sonnet',usage:{input_tokens:4,output_tokens:0}}});
const stop = reason => {emit({type:'message_delta',delta:{stop_reason:reason,stop_sequence:null},usage:{output_tokens:2}});emit({type:'message_stop'});};
if (args.includes('--version')) {process.stdout.write('fixture-cli'); process.exit(0);}
if(args[0]==='auth' && args[1]==='status') { process.stdout.write(JSON.stringify({loggedIn:true,email:'fixture@example.test'})); process.exit(0); }
if(args[0]==='auth') {
 process.stdout.write('https://claude.ai/oauth/authorize?state=fixture-state\\n');
 const login=readline.createInterface({input:process.stdin});
 login.once('line',async()=>{await writeFile('.credentials.json',JSON.stringify({claudeAiOauth:{accessToken:'login-access',refreshToken:'login-refresh',expiresAt:Date.now()+3600000}}));login.close();});
} else {
const config = JSON.parse(args[args.indexOf('--mcp-config')+1]).mcpServers.lcode;
const rl=readline.createInterface({input:process.stdin});
rl.once('line', async line => {
 const input = JSON.parse(line);
 await writeFile('.credentials.json',JSON.stringify({claudeAiOauth:{accessToken:'runtime-access',refreshToken:'runtime-refresh',expiresAt:Date.now()+3600000}}));
 if(JSON.stringify(input).includes('fail-before-output')) {process.stdout.write(JSON.stringify({type:'result',is_error:true})+'\\n');rl.close();return;}
 if (JSON.stringify(input).includes('hold-open')) {start('wait');return;}
 const unauthorized = await fetch(config.url,{method:'POST',body:'{}'});
 if (unauthorized.status!==401) process.exit(2);
 start('one');
 emit({type:'content_block_start',index:0,content_block:{type:'tool_use',id:'tool_1',name:'mcp__lcode__read_file',input:{}}});
 emit({type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"path":"a"}'}});
 emit({type:'content_block_stop',index:0}); stop('tool_use');
 const response=await fetch(config.url,{method:'POST',headers:{...config.headers,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'read_file',arguments:{path:'a'}}})});
 const result=await response.json();
 start('two');emit({type:'content_block_start',index:0,content_block:{type:'text',text:''}});
 emit({type:'content_block_delta',index:0,delta:{type:'text_delta',text:result.result.content[0].text}});
 emit({type:'content_block_stop',index:0});stop('end_turn');
 process.stdout.write(JSON.stringify({type:'result',is_error:false})+'\\n');rl.close();
});}`;

function fixtureDriver() {
  const directories: string[] = [];
  const children: ReturnType<typeof spawn>[] = [];
  const runner: ClaudeSpawner = (args, dir, additions) => {
    directories.push(dir);
    const child = spawn(process.execPath, ["--input-type=module", "-e", fixture, "--", ...args], {
      cwd: dir,
      env: { ...claudeEnvironment(dir), ...additions },
      windowsHide: true,
      shell: false,
      stdio: "pipe",
    });
    children.push(child);
    return child;
  };
  const driver = new ClaudeAuthDriver(runner, undefined, async () =>
    Response.json({
      anthropic: {
        models: {
          "claude-fixture": {
            name: "Fixture",
            limit: { context: 200000, output: 64000 },
            tool_call: true,
          },
        },
      },
    }),
  );
  let grant: AuthGrant = claudeGrant({
    claudeAiOauth: {
      accessToken: "fixture-access",
      refreshToken: "fixture-refresh",
      expiresAt: Date.now() + 3600_000,
    },
  });
  const context: AuthDriverContext = {
    connectionId: "fixture-account-a",
    read: async () => grant,
    write: async (value) => {
      grant = value;
    },
  };
  return { driver, context, directories, children };
}
const request = (body: unknown, signal?: AbortSignal) =>
  new Request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    body: JSON.stringify(body),
    signal,
  });

test("Claude CLI bridge emits external tool, waits for result, and continues the same process", async () => {
  const { driver, context, directories, children } = fixtureDriver();
  try {
    assert.equal((await driver.models(context))[0]?.id, "sonnet");
    const common = {
      model: "sonnet",
      stream: true,
      tools: [
        {
          name: "read_file",
          input_schema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    };
    const first = await driver.fetch(
      request({ ...common, messages: [{ role: "user", content: "read a" }] }),
      context,
    );
    const wire = await first.text();
    const toolId = /"id":"(toolu_lcode_[^"]+)"/.exec(wire)?.[1];
    assert.ok(toolId);
    assert.equal(
      (await context.read())?.refresh,
      "runtime-refresh",
      "persist CLI refresh before returning the first tool turn",
    );
    assert.match(wire, /"name":"read_file"/);
    assert.doesNotMatch(wire, /mcp__lcode__/);
    assert.match(wire, /"stop_reason":"tool_use"/);
    const second = await driver.fetch(
      request({
        ...common,
        stream: false,
        messages: [
          { role: "user", content: "read a" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: toolId, name: "read_file", input: { path: "a" } }],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: toolId, content: "actual tool contents" },
            ],
          },
        ],
      }),
      context,
    );
    const result = record(await second.json());
    assert.equal(record(list(result.content)[0]).text, "actual tool contents");
    assert.equal(result.stop_reason, "end_turn");
    assert.equal(record(result.usage).input_tokens, 4);
    assert.equal(
      children.length,
      2,
      "version check plus one inference CLI; tool result does not start a new CLI",
    );
    assert.equal(new Set(directories).size, 1, "account shares exactly one credential profile");
    const credential = JSON.parse(
      await readFile(join(directories[0]!, ".credentials.json"), "utf8"),
    );
    assert.equal(credential.claudeAiOauth.accessToken, "runtime-access");
    await assert.rejects(
      driver.fetch(request({}), { ...context, connectionId: "another-account" }),
      /shared between accounts/,
    );
  } finally {
    await driver.dispose();
  }
  await assert.rejects(access(directories[0]!));
});

test("Claude cancellation terminates a live CLI and isolates inherited auth", async () => {
  const { driver, context, children } = fixtureDriver();
  const controller = new AbortController();
  try {
    const response = await driver.fetch(
      request(
        { model: "sonnet", stream: true, messages: [{ role: "user", content: "hold-open" }] },
        controller.signal,
      ),
      context,
    );
    controller.abort();
    assert.match(await response.text(), /cancelled/);
    assert.ok(children[0]?.killed);
    const environment = claudeEnvironment("isolated");
    assert.equal(environment.CLAUDE_CONFIG_DIR, "isolated");
    assert.equal(environment.ANTHROPIC_API_KEY, undefined);
    assert.equal(environment.ANTHROPIC_AUTH_TOKEN, undefined);
  } finally {
    await driver.dispose();
  }
});

test("Claude sign-in is performed by the isolated CLI and failure before output preserves HTTP failure", async () => {
  const { driver, context } = fixtureDriver();
  try {
    const challenge = await driver.authorize("browser", {}, new AbortController().signal);
    assert.match(challenge.url!, /^https:\/\/claude.ai/);
    const grant = await challenge.complete("fixture-code#fixture-state");
    assert.equal(grant.access, "login-access");
    assert.equal(grant.refresh, "login-refresh");
    const response = await driver.fetch(
      request({
        model: "sonnet",
        stream: true,
        messages: [{ role: "user", content: "fail-before-output" }],
      }),
      context,
    );
    assert.equal(response.status, 502);
    assert.match(await response.text(), /model request failed/);
  } finally {
    await driver.dispose();
  }
});

test("Claude namespaces duplicate upstream tool IDs and rejects cross-conversation continuation", async () => {
  const { driver, context, children } = fixtureDriver();
  const common = {
    model: "sonnet",
    stream: true,
    tools: [
      {
        name: "read_file",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      },
    ],
  };
  const original = { role: "user", content: "same prompt in two chats" };
  const continuation = (id: string, result: string, first = original) => ({
    ...common,
    stream: false,
    messages: [
      first,
      {
        role: "assistant",
        content: [{ type: "tool_use", id, name: "read_file", input: { path: "a" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: result }] },
    ],
  });
  try {
    const first = await driver.fetch(request({ ...common, messages: [original] }), context);
    const second = await driver.fetch(request({ ...common, messages: [original] }), context);
    const firstId = /"id":"(toolu_lcode_[^"]+)"/.exec(await first.text())?.[1];
    const secondId = /"id":"(toolu_lcode_[^"]+)"/.exec(await second.text())?.[1];
    assert.ok(firstId);
    assert.ok(secondId);
    assert.notEqual(firstId, secondId);
    await assert.rejects(
      driver.fetch(
        request(
          continuation(firstId, "wrong", { role: "user", content: "a different conversation" }),
        ),
        context,
      ),
      /another conversation/,
    );
    const secondResult = record(
      await (await driver.fetch(request(continuation(secondId, "second result")), context)).json(),
    );
    assert.equal(record(list(secondResult.content)[0]).text, "second result");
    const firstResult = record(
      await (await driver.fetch(request(continuation(firstId, "first result")), context)).json(),
    );
    assert.equal(record(list(firstResult.content)[0]).text, "first result");
    assert.equal(children.length, 2);
  } finally {
    await driver.dispose();
  }
});
