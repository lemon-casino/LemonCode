import assert from "node:assert/strict";
import test from "node:test";
import type { V4SessionRecordView } from "../types.js";
import { prepareSendTextContextRefs, V4InputAdmissionRejectedError } from "./send-text-context.js";

test("capsule pre-admission validation rejects stale refs and preserves independent share refs", async () => {
  const capsule = { kind: "context_capsule" as const, capsule_id: `capsule_${"a".repeat(32)}` };
  const share = { kind: "shared_context_import" as const, context_id: "context" };
  let valid = false,
    calls = 0;
  const record = {
    app: {
      runtime: {
        validateContextCapsuleReferences: async (references: unknown[]) => {
          calls++;
          assert.deepEqual(references, [capsule]);
          return valid;
        },
      },
    },
  } as unknown as V4SessionRecordView;
  await assert.rejects(
    prepareSendTextContextRefs(record, [share, capsule]),
    (error) =>
      error instanceof V4InputAdmissionRejectedError &&
      error.reasonCode === "fault.command.inputRejected",
  );
  valid = true;
  assert.deepEqual(await prepareSendTextContextRefs(record, [share, capsule]), {
    sharedContextRefs: [share],
    contextCapsuleRefs: [capsule],
  });
  assert.deepEqual(await prepareSendTextContextRefs(record, [share]), {
    sharedContextRefs: [share],
    contextCapsuleRefs: [],
  });
  assert.equal(calls, 2);
});
