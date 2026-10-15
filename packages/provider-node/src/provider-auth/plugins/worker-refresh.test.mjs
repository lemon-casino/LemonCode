import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import test from "node:test";
import { createWorkerRefresh } from "./worker-refresh.mjs";

const url = "https://api.cline.bot/api/v1/auth/refresh";
const init = {
  method: "POST",
  body: JSON.stringify({ grantType: "refresh_token", refreshToken: "fixture" }),
};
test("cancellation while acquiring Host permission cannot dispatch a detached refresh", async () => {
  const scopes = new AsyncLocalStorage(),
    gate = Promise.withResolvers(),
    events = [];
  const scope = { id: 1, controller: new AbortController() };
  const owner = createWorkerRefresh({
    channel: "cline",
    scopes,
    credential: () => gate.promise,
    send: (event) => events.push(event),
  });
  const waiting = scopes.run(scope, () => owner.before(url, init));
  scope.controller.abort();
  gate.resolve({ allowed: true });
  await assert.rejects(waiting, { name: "AbortError" });
  assert.equal(scope.rotation, undefined);
  owner.end(scope);
  assert.deepEqual(events, [{ kind: "refresh-end", operationId: 1, admitted: false }]);
});
test("active rotation never grants cancelled business RPC and commit revokes it", async () => {
  const scopes = new AsyncLocalStorage(),
    scope = { id: 1, controller: new AbortController() };
  const owner = createWorkerRefresh({
    channel: "cline",
    scopes,
    credential: async () => ({ allowed: true }),
    send: () => {},
  });
  const signal = await scopes.run(scope, () => owner.before(url, init));
  scope.controller.abort();
  assert.equal(signal.aborted, false);
  await assert.rejects(
    scopes.run(scope, () => owner.before("https://api.cline.bot/v1/models", {})),
    { name: "AbortError" },
  );
  owner.committed(scope);
  assert.equal(signal.aborted, true);
  assert.equal(scope.rotation, undefined);
});
