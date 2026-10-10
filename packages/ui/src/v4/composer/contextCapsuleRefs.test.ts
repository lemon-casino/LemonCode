import assert from "node:assert/strict";
import test from "node:test";
import { readComposerCapsuleRefs } from "./contextCapsuleRefs.js";
const id = "capsule_" + "a".repeat(32);
test("code examples never admit saved context through indentation or an invalid closing fence", () => {
  for (const text of [
    `    #${id}`,
    `\t#${id}`,
    ["~~~md", "~~~not-a-close", `#${id}`, "~~~"].join("\n"),
    ["````md", "```", `#${id}`, "````"].join("\n"),
  ])
    assert.deepEqual(readComposerCapsuleRefs(text), [], text);
  assert.deepEqual(readComposerCapsuleRefs(["~~~md", `#${id}`, "~~~~  ", ` #${id}`].join("\n")), [
    { kind: "context_capsule", capsule_id: id },
  ]);
});
test("only explicit standalone capsule references are frozen and deduplicated", () => {
  assert.deepEqual(readComposerCapsuleRefs(`#${id}\n#${id}\ninline #${id}`), [
    { kind: "context_capsule", capsule_id: id },
  ]);
  assert.deepEqual(
    readComposerCapsuleRefs(`~~~text\n#${id}\n~~~\n> #${id}\n\`\`\`\n#${id}\n\`\`\``),
    [],
  );
  assert.throws(
    () =>
      readComposerCapsuleRefs(
        ["a", "b", "c", "d", "e"].map((c) => "#capsule_" + c.repeat(32)).join("\n"),
      ),
    /at most 4/,
  );
});
