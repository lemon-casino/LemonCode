import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_API_KEY_IMPORT_BYTES,
  createProviderApiKeyId,
  mergeProviderApiKeyImport,
  parseProviderApiKeyImport,
  ProviderApiKeyImportError,
  readProviderApiKeyImportFiles,
} from "./providerApiKeyImport.js";
import { createProviderApiKeyOperationGuard } from "./providerApiKeys.js";

function expectError(code: ProviderApiKeyImportError["code"]) {
  return (error: unknown) => error instanceof ProviderApiKeyImportError && error.code === code;
}

test("local IDs work without secure-context randomUUID and remain distinct", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  try {
    Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true });
    const ids = Array.from({ length: 1_000 }, createProviderApiKeyId);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every((id) => id.startsWith("key-") && id.length > 10));
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
  }
});

test("mixed text separators, BOM, quoting and opaque provider prefixes", () => {
  assert.deepEqual(
    parseProviderApiKeyImport(
      "\uFEFF demo-one  demo-two\r\n\tdemo-three;demo-four；demo-five,demo-six，demo-seven、'demo-eight'|demo-nine ",
    ),
    Array.from({ length: 9 }, (_, index) => ({
      apiKey: `demo-${["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"][index]}`,
      enabled: true,
    })),
  );
});

test("JSON string and string array keep each key opaque", () => {
  assert.deepEqual(parseProviderApiKeyImport('"demo-one"'), [
    { apiKey: "demo-one", enabled: true },
  ]);
  assert.deepEqual(parseProviderApiKeyImport('[" demo-one ", "demo;two", "demo,three", ""]'), [
    { apiKey: "demo-one", enabled: true },
    { apiKey: "demo;two", enabled: true },
    { apiKey: "demo,three", enabled: true },
  ]);
});

test("JSON records support key aliases, label/name and explicit disabled state", () => {
  assert.deepEqual(
    parseProviderApiKeyImport(
      JSON.stringify([
        { id: "foreign-id", apiKey: "demo-one", label: " Primary ", enabled: false },
        { api_key: "demo-two", name: "Backup" },
        { key: "demo-three" },
        { token: "demo-four" },
      ]),
    ),
    [
      { apiKey: "demo-one", label: "Primary", enabled: false },
      { apiKey: "demo-two", label: "Backup", enabled: true },
      { apiKey: "demo-three", enabled: true },
      { apiKey: "demo-four", enabled: true },
    ],
  );
});

test("known wrappers read only key entries and never collect metadata strings", () => {
  for (const wrapper of ["apiKeys", "api_keys", "keys", "data", "items"]) {
    assert.deepEqual(
      parseProviderApiKeyImport(
        JSON.stringify({
          config: {
            access: {
              [wrapper]: [{ apiKey: "demo-one", name: "Example", url: "https://example.com" }],
            },
          },
          name: "Provider name",
          url: "https://example.com",
        }),
      ),
      [{ apiKey: "demo-one", label: "Example", enabled: true }],
    );
  }
});

test("invalid JSON never falls back to importing punctuation or leaks its contents", () => {
  const source = '[{"apiKey":"demo-sensitive-value",}]';
  assert.throws(
    () => parseProviderApiKeyImport(source),
    (error) => {
      assert.ok(error instanceof ProviderApiKeyImportError);
      assert.equal(error.code, "invalidJson");
      assert.ok(!error.message.includes("demo-sensitive-value"));
      return true;
    },
  );
});

test("provider access exports prefer the full key list over its legacy primary key", () => {
  assert.deepEqual(
    parseProviderApiKeyImport(
      JSON.stringify({
        access: {
          apiKey: "demo-two",
          apiKeys: [
            { id: "a", apiKey: "demo-one", label: "Disabled", enabled: false },
            { id: "b", apiKey: "demo-two", enabled: true },
          ],
        },
      }),
    ),
    [
      { apiKey: "demo-one", label: "Disabled", enabled: false },
      { apiKey: "demo-two", enabled: true },
    ],
  );
});

test("unsupported JSON entries fail the whole batch instead of importing metadata", () => {
  for (const source of [
    '{"name":"Provider","url":"https://example.com"}',
    '["demo-one", 42]',
    '[{"apiKey":123}]',
    '[{"apiKey":"demo-one","enabled":"false"}]',
    '[{"apiKey":"two keys"}]',
    "[null]",
  ]) {
    assert.throws(() => parseProviderApiKeyImport(source), expectError("invalidFormat"));
  }
});

test("empty input, empty JSON and separators produce a useful empty error", () => {
  for (const source of ["", " ; ， \r\n", "[]", '[" "]', '{"apiKeys":[]}']) {
    assert.throws(() => parseProviderApiKeyImport(source), expectError("empty"));
  }
});

test("binary content and deeply nested JSON fail with sanitized errors", () => {
  assert.throws(() => parseProviderApiKeyImport("demo-one\0binary"), expectError("invalidFormat"));
  assert.throws(
    () => parseProviderApiKeyImport(JSON.stringify({ apiKey: "demo\0binary" })),
    expectError("invalidFormat"),
  );
  assert.throws(
    () => parseProviderApiKeyImport("[".repeat(100) + '"demo-one"' + "]".repeat(100)),
    expectError("invalidFormat"),
  );
});

test("text limits count UTF-8 bytes", () => {
  assert.throws(
    () => parseProviderApiKeyImport("x".repeat(MAX_API_KEY_IMPORT_BYTES + 1)),
    expectError("tooLarge"),
  );
  assert.throws(
    () => parseProviderApiKeyImport("中".repeat(Math.ceil(MAX_API_KEY_IMPORT_BYTES / 3))),
    expectError("tooLarge"),
  );
});

test("merge preserves drafts and disabled entries, deduplicates, and creates unique local IDs", () => {
  const draft = [
    { id: "existing", apiKey: " demo-one ", label: "Existing", enabled: false },
    { id: "empty-draft", apiKey: "", label: "Unfinished", enabled: true },
  ];
  let sequence = 0;
  const result = mergeProviderApiKeyImport(
    draft,
    parseProviderApiKeyImport(
      JSON.stringify([
        { id: "existing", apiKey: "demo-one", name: "Overwrite", enabled: true },
        { id: "existing", apiKey: "demo-two", name: "Backup", enabled: false },
        "demo-two",
        "DEMO-two",
        "demo-three",
      ]),
    ),
    () => `local-${++sequence}`,
  );
  assert.equal(result.added, 3);
  assert.equal(result.duplicates, 2);
  assert.deepEqual(result.draft, [
    ...draft,
    { id: "local-1", apiKey: "demo-two", label: "Backup", enabled: false },
    { id: "local-2", apiKey: "DEMO-two", label: "API Key 4", enabled: true },
    { id: "local-3", apiKey: "demo-three", label: "API Key 5", enabled: true },
  ]);
  assert.equal(draft.length, 2);
  const repeated = mergeProviderApiKeyImport(
    result.draft,
    parseProviderApiKeyImport("demo-two demo-three"),
  );
  assert.equal(repeated.added, 0);
  assert.equal(repeated.duplicates, 2);
  assert.deepEqual(repeated.draft, result.draft);
});

test("file reading uses input order even when IO completes out of order", async () => {
  let finishFirst!: (value: string) => void;
  const first = new Promise<string>((resolve) => {
    finishFirst = resolve;
  });
  const reading = readProviderApiKeyImportFiles([
    { size: 8, text: () => first },
    { size: 8, text: async () => '[{"key":"demo-two","enabled":false}]' },
  ]);
  finishFirst("demo-one");
  assert.deepEqual(await reading, [
    { apiKey: "demo-one", enabled: true },
    { apiKey: "demo-two", enabled: false },
  ]);
});

test("file read errors and a malformed member reject an entire batch without raw errors", async () => {
  await assert.rejects(
    readProviderApiKeyImportFiles([
      { size: 8, text: async () => "demo-one" },
      {
        size: 8,
        text: async () => {
          throw new Error("demo-sensitive-value");
        },
      },
    ]),
    expectError("readFailed"),
  );
  await assert.rejects(
    readProviderApiKeyImportFiles([
      { size: 8, text: async () => "demo-one" },
      { size: 8, text: async () => "[broken" },
    ]),
    expectError("invalidJson"),
  );
});

test("total file size is checked before reading", async () => {
  let reads = 0;
  const text = async () => {
    reads += 1;
    return "demo-one";
  };
  await assert.rejects(
    readProviderApiKeyImportFiles([
      { size: MAX_API_KEY_IMPORT_BYTES, text },
      { size: 1, text },
    ]),
    expectError("tooLarge"),
  );
  assert.equal(reads, 0);
});

test("late file results cannot cross provider or close boundaries", async () => {
  for (const transition of ["switch", "close"] as const) {
    const guard = createProviderApiKeyOperationGuard("provider-a");
    const operation = guard.begin();
    let finish!: (value: string) => void;
    const reading = readProviderApiKeyImportFiles([
      {
        size: 8,
        text: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
    ]);
    guard.setScope(transition === "switch" ? "provider-b" : null);
    finish("demo-one");
    await reading;
    assert.equal(guard.isCurrent(operation), false);
  }
});
