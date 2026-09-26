import assert from "node:assert/strict";
import test from "node:test";
import type { SharedZCodeCredentialStore } from "@zcode/adapters/auth";
import {
  ModelErrorCode,
  ModelFailureReason,
  ModelProtocolError,
  type TraceContext,
} from "@zcode/contracts";
import type { ZCodeProviderAccountAccess } from "@zcode/shared";
import { createStandaloneProviderRuntimeHeadersPort } from "./standalone-account-provider-runtime.js";

const accountAccess = {
  accountType: "zai",
  entitled: true,
  mode: "individual-coding-plan",
  type: "zhipu-account",
} satisfies ZCodeProviderAccountAccess;

function createStore(
  load: (key: string) => Promise<string | null>,
): Pick<SharedZCodeCredentialStore, "load" | "loadMany"> {
  return {
    load,
    loadMany: async () => ({}),
  };
}

function refresh(
  store: Pick<SharedZCodeCredentialStore, "load" | "loadMany">,
  options: { abortSignal?: AbortSignal; accountAccess?: ZCodeProviderAccountAccess } = {},
) {
  return createStandaloneProviderRuntimeHeadersPort(store, {}).refreshBeforeModelRequest({
    accountAccess: options.accountAccess ?? accountAccess,
    abortSignal: options.abortSignal,
    modelId: "model-a",
    providerId: "provider-a",
    reason: "model-request",
    sessionId: "session-a" as never,
    traceContext: {} as TraceContext,
  });
}

function assertAuthMissing(error: unknown): boolean {
  assert.ok(error instanceof ModelProtocolError);
  assert.equal(error.code, ModelErrorCode.ModelRequestAuthMissing);
  assert.equal(error.context?.reason, ModelFailureReason.AuthFailed);
  return true;
}

test("missing standalone account identity is a structured request-auth failure", async () => {
  await assert.rejects(refresh(createStore(async () => null)), assertAuthMissing);
});

test("missing standalone account api key is a structured request-auth failure", async () => {
  let loadCount = 0;
  await assert.rejects(
    refresh(
      createStore(async () => {
        loadCount += 1;
        return loadCount === 1 ? "identity-a" : null;
      }),
    ),
    assertAuthMissing,
  );
  assert.equal(loadCount, 2);
});

test("invalid account access remains a local configuration failure", async () => {
  await assert.rejects(
    refresh(
      createStore(async () => null),
      {
        accountAccess: { ...accountAccess, mode: "start-plan" },
      },
    ),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof ModelProtocolError, false);
      return true;
    },
  );
});

test("credential-store IO failures remain local errors", async () => {
  const localFailure = new Error("credential store unavailable");
  await assert.rejects(
    refresh(
      createStore(async () => {
        throw localFailure;
      }),
    ),
    (error) => error === localFailure,
  );
});

test("cancellation while loading identity wins over missing-auth attribution", async () => {
  const controller = new AbortController();
  const cancellation = new Error("cancelled by user");
  const store = createStore(async () => {
    controller.abort(cancellation);
    return null;
  });

  await assert.rejects(
    refresh(store, { abortSignal: controller.signal }),
    (error) => error === cancellation,
  );
});
