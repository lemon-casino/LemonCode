import assert from "node:assert/strict";
import test from "node:test";
import { projectContextForDefinition } from "../packages/shared/src/projectContext.js";
import { resolveAdmissionProjectContext } from "../apps/lcode-cli/packages/bootstrap/src/lcode-protocol/admission-project-context.js";
import {
  inputIntentMetadata,
  inputIntentMetadataFromQueueItem,
} from "../apps/lcode-cli/packages/bootstrap/src/lcode-protocol-v4/commands/input-intent.js";
import { buildPersistedConversationInputIntent } from "../apps/lcode-cli/packages/core/src/runtime/methods/input-intent-persistence.js";

test("admitted project revision survives queue persistence and promotion after project editing", async () => {
  const workspace = { workspacePath: "/web", workspaceKey: "/web" };
  const snapshot = projectContextForDefinition(
    {
      id: "shop",
      name: "Shop",
      revision: 2,
      primaryFolderPath: "/web",
      sourceFolderPaths: ["/web", "/api"],
    },
    workspace,
  );
  let requests = 0;
  const context = {
    sessions: new Map([["chat", { workspace, traceContext: { traceId: "trace" } }]]),
    requestClient: async (_method: string, params: unknown) => {
      requests++;
      assert.deepEqual(params, {
        sessionId: "chat",
        scope: "project-admission",
        projectContext: { version: 1, workspace },
      });
      return { projectContext: structuredClone(snapshot) };
    },
  };
  const projectContext = await resolveAdmissionProjectContext(context as never, "chat");
  const envelope = {
    commandId: "input",
    clientId: "desktop",
    type: "sendText",
    __v4Admission: { admissionSeq: 7, admittedAt: 123, queueItemId: "queue_input", projectContext },
  };
  const intent = inputIntentMetadata(envelope as never, {
    text: "implement",
    requestedDelivery: "queue",
  });
  snapshot.revision = 3;
  snapshot.members.pop();
  const persisted = buildPersistedConversationInputIntent("implement", intent, "queued");
  const promoted = inputIntentMetadataFromQueueItem(persisted as never, "implement");
  assert.equal(promoted.projectContext?.revision, 2);
  assert.equal(promoted.projectContext?.members.length, 2);
  assert.equal(requests, 1, "promotion never resolves a newer project version");
  await assert.rejects(
    resolveAdmissionProjectContext(
      { ...context, requestClient: async () => ({}) } as never,
      "chat",
    ),
    /does not support/,
  );
});
