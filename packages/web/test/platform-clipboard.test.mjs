import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

for (const [name, path, declaration] of [
  [
    "Desktop",
    "../../desktop/src/renderer/src/desktopPlatform.ts",
    "export function createDesktopPlatform",
  ],
  ["Web / mobile", "../src/main.tsx", "function createWebPlatform"],
]) {
  test(`${name} 剪贴板适配器写入当前设备，原样传递并保留权限失败`, async () => {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    const factory = source.slice(source.indexOf(declaration));
    const member = factory.match(
      /async writeClipboardText\(text(?:: string)?\)\s*\{([\s\S]*?)\n\s*\},/,
    );
    assert.ok(member, "platform adapter must implement the shared clipboard contract");
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    const copy = new AsyncFunction("navigator", "text", member[1]);
    const calls = [];
    await copy(
      {
        clipboard: {
          writeText: async (text) => {
            calls.push(text);
          },
        },
      },
      "feat: 中文\n\n正文",
    );
    assert.deepEqual(calls, ["feat: 中文\n\n正文"]);
    await assert.rejects(copy({}, "never copied"), /Clipboard is unavailable/);
    const denied = new Error("permission-denied-fixture");
    await assert.rejects(
      copy(
        {
          clipboard: {
            writeText: async () => {
              throw denied;
            },
          },
        },
        "private",
      ),
      (error) => error === denied,
    );
    assert.doesNotMatch(member[1], /console\.|logger\.|window\.lcode|fetch\(/);
  });
}

test("shared 剪贴板能力保持可选，不给旧平台伪造成功", async () => {
  const source = await readFile(new URL("../../shared/src/platform.ts", import.meta.url), "utf8");
  assert.ok(/writeClipboardText\?\(text: string\): Promise<void>/.test(source));
});
