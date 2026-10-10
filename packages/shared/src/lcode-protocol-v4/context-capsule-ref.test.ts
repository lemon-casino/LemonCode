import assert from "node:assert/strict";
import test from "node:test";
import { conversationContextRefsSchema } from "./shared-context-ref.js";

test("typed capsule and share context refs have independent limits and reject duplicate/unknown shapes", () => {
  const capsules = Array.from({ length: 4 }, (_, index) => ({
    kind: "context_capsule",
    capsule_id: `capsule_${String(index).repeat(32)}`,
  }));
  assert.equal(
    conversationContextRefsSchema.safeParse([
      ...capsules,
      { kind: "shared_context_import", context_id: "share" },
    ]).success,
    true,
  );
  assert.equal(
    conversationContextRefsSchema.safeParse([
      ...capsules,
      { kind: "context_capsule", capsule_id: `capsule_${"a".repeat(32)}` },
    ]).success,
    false,
  );
  assert.equal(conversationContextRefsSchema.safeParse([capsules[0], capsules[0]]).success, false);
  assert.equal(
    conversationContextRefsSchema.safeParse([{ kind: "context_capsule", capsule_id: "foreign" }])
      .success,
    false,
  );
});
