import assert from "node:assert/strict";
import test from "node:test";
import { MemoryReviewError } from "../../memory/review-common.js";
import { harness } from "./project-memory-extraction.test-support.js";

test("background truncation records only the stable phase/code and never persists a review", async () => {
  for (const phase of ["generation", "verification"] as const) {
    const h = harness();
    const logs: unknown[] = [];
    h.runtime.logger = {
      info: (_message, data) => logs.push(data),
      warn: (_message, data) => logs.push(data),
    } as NonNullable<typeof h.runtime.logger>;
    h.onModel(() => {
      if (h.requests.length === (phase === "generation" ? 1 : 2))
        throw new MemoryReviewError("output_truncated", phase);
    });
    h.schedule();
    await h.drain();
    assert.equal(h.requests.length, phase === "generation" ? 1 : 2);
    assert.equal(h.applied.length, 0);
    assert.equal(h.saved.length, 0);
    assert.equal(h.runtime.memoryExtractionScheduler!.getCursor(), undefined);
    const diagnostic = logs.find(
      (x) => (x as { event?: string }).event === "memory.extraction.failed",
    ) as { code: string; phase: string };
    assert.equal(diagnostic.code, "output_truncated");
    assert.equal(diagnostic.phase, phase);
    assert.doesNotMatch(
      JSON.stringify(logs),
      /deterministic fixture|testing\.md|automatic-review-workspace/u,
    );
  }
});

test("window admission failure is observable without logging raw transcript material", async () => {
  const h = harness();
  const logs: unknown[] = [];
  h.runtime.logger = { warn: (_message, data) => logs.push(data) } as NonNullable<
    typeof h.runtime.logger
  >;
  h.patchWindow({ boundaryFound: false });
  h.schedule();
  await h.drain();
  assert.equal(h.requests.length, 0);
  assert.equal(logs.length, 1);
  assert.equal((logs[0] as { event: string }).event, "memory.extraction.window_unavailable");
  assert.doesNotMatch(JSON.stringify(logs), /deterministic fixture/u);
});
