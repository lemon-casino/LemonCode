import assert from "node:assert/strict";
import test from "node:test";
import { lcodeProtocolMethods } from "@lcode/shared";
import {
  requestClient,
  resolveClientRequest,
  type ProtocolClientRequestState,
} from "./server-client-requests.js";

test("lifecycle waiting has a deadline while the original request owner validates a late ACK", async () => {
  const host: ProtocolClientRequestState = {
    pendingClientRequests: new Map(),
    nextClientRequestId: 1,
    messageSink() {},
  };
  const seen: unknown[] = [];
  const waiting = requestClient(
    host,
    lcodeProtocolMethods.interactionBrowserExecute,
    {},
    { parse: (value) => value },
    {
      timeoutMs: 1,
      onLateResponse: (response) => seen.push(response),
    },
  );
  await assert.rejects(waiting, { code: -32022 });
  assert.equal(host.pendingClientRequests.size, 1);
  resolveClientRequest(host, "server-1", { ok: true, elapsedMs: 0 });
  assert.deepEqual(seen, [{ result: { ok: true, elapsedMs: 0 } }]);
  assert.equal(host.pendingClientRequests.size, 0);
});

test("ordinary RPC deadlines release their request IDs and ignore late responses", async () => {
  const host: ProtocolClientRequestState = {
    pendingClientRequests: new Map(),
    nextClientRequestId: 1,
    messageSink() {},
  };
  await assert.rejects(
    requestClient(
      host,
      lcodeProtocolMethods.interactionBrowserExecute,
      {},
      { parse: (value) => value },
      { timeoutMs: 1 },
    ),
    { code: -32022 },
  );
  assert.equal(host.pendingClientRequests.size, 0);
  resolveClientRequest(host, "server-1", {});
  assert.equal(host.pendingClientRequests.size, 0);
});
