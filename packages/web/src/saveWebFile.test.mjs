import { strict as assert } from "node:assert";
import { afterEach, describe, it, mock } from "node:test";
import { saveWebFile } from "./saveWebFile.ts";

const bytes = new Uint8Array([0, 1, 127, 128, 255]);
const request = { data: bytes.buffer, suggestedName: "git-backup-private-key.pem" };
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

function installBrowser(failAt) {
  const events = [];
  const blobs = [];
  const anchors = [];
  const fail = (stage) => {
    if (stage === failAt) throw new Error(`sensitive detail from ${stage}`);
  };
  mock.timers.enable({ apis: ["setTimeout"] });
  mock.method(globalThis, "fetch", () => assert.fail("saveFile must not access the network"));
  mock.method(URL, "createObjectURL", (blob) => {
    fail("objectUrl");
    blobs.push(blob);
    events.push("createUrl");
    return "blob:test-download";
  });
  mock.method(URL, "revokeObjectURL", (url) => {
    assert.equal(url, "blob:test-download");
    events.push("revokeUrl");
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement(tag) {
        assert.equal(tag, "a");
        fail("anchor");
        const anchor = {
          href: "",
          download: "",
          click() {
            fail("click");
            assert.equal(anchor.attached, true);
            events.push("click");
          },
          remove() {
            anchor.attached = false;
            events.push("remove");
          },
        };
        anchors.push(anchor);
        return anchor;
      },
      body: {
        appendChild(anchor) {
          fail("append");
          anchor.attached = true;
          events.push("append");
        },
      },
    },
  });
  return { events, blobs, anchors };
}

afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else delete globalThis.document;
});

// Web 只能确认已发起下载；不能伪造原生路径、落盘完成或下载后的取消状态。
describe("saveWebFile", () => {
  it("downloads exact bytes only on invocation and releases its object URL after initiation", async () => {
    const browser = installBrowser();
    assert.deepEqual(browser.events, []);
    const result = await saveWebFile(request);
    assert.deepEqual(result, { success: true });
    assert.equal(browser.blobs[0].type, "application/octet-stream");
    assert.deepEqual(new Uint8Array(await browser.blobs[0].arrayBuffer()), bytes);
    assert.equal(browser.anchors[0].href, "blob:test-download");
    assert.equal(browser.anchors[0].download, request.suggestedName);
    assert.equal(browser.anchors[0].attached, false);
    assert.deepEqual(browser.events, ["createUrl", "append", "click", "remove"]);
    mock.timers.tick(0);
    assert.deepEqual(browser.events, ["createUrl", "append", "click", "remove", "revokeUrl"]);
  });

  it("uses a safe basename rather than a supplied filesystem path", async () => {
    const browser = installBrowser();
    assert.deepEqual(
      await saveWebFile({ ...request, suggestedName: " C:\\backup/key:<secret>?.pem " }),
      { success: true },
    );
    assert.equal(browser.anchors[0].download, "key--secret--.pem");
    mock.timers.tick(0);
    assert.equal(browser.events.at(-1), "revokeUrl");
  });

  it("rejects sourceUrl without fetching, navigating or creating a Blob URL", async () => {
    const browser = installBrowser();
    for (const sourceUrl of ["https://example.com/key.pem", "javascript:alert(1)", "blob:other"]) {
      assert.deepEqual(await saveWebFile({ sourceUrl, suggestedName: "key.pem" }), {
        success: false,
        error: "source_url_not_supported",
      });
    }
    assert.deepEqual(browser.events, []);
    assert.deepEqual(browser.anchors, []);
  });

  it("rejects invalid, empty or ambiguous payloads without retaining browser resources", async () => {
    const browser = installBrowser();
    const invalid = [
      null,
      {},
      { ...request, data: bytes },
      { ...request, data: new ArrayBuffer(0) },
      { ...request, suggestedName: " " },
      { ...request, suggestedName: ".." },
      { ...request, suggestedName: "/backup/" },
      { ...request, suggestedName: 42 },
      { ...request, sourceUrl: "https://example.com/key.pem" },
      { sourceUrl: "", suggestedName: "key.pem" },
    ];
    for (const payload of invalid) {
      assert.deepEqual(await saveWebFile(payload), {
        success: false,
        error: "invalid_file_payload",
      });
    }
    assert.deepEqual(browser.events, []);
  });

  it("enforces the existing 50 MiB download limit before creating a Blob URL", async () => {
    const browser = installBrowser();
    assert.deepEqual(
      await saveWebFile({ ...request, data: new ArrayBuffer(50 * 1024 * 1024 + 1) }),
      {
        success: false,
        error: "file_too_large",
      },
    );
    assert.deepEqual(browser.events, []);
  });

  for (const stage of ["objectUrl", "anchor", "append", "click"]) {
    it(`returns a content-free error and cleans up after ${stage} failure`, async () => {
      const browser = installBrowser(stage);
      assert.deepEqual(await saveWebFile(request), { success: false, error: "download_failed" });
      if (stage === "objectUrl") {
        assert.deepEqual(browser.events, []);
      } else {
        assert.equal(browser.events.at(-1), "revokeUrl");
        assert.equal(browser.events.filter((event) => event === "revokeUrl").length, 1);
      }
      for (const anchor of browser.anchors) assert.equal(anchor.attached, false);
      const beforeTimers = [...browser.events];
      mock.timers.tick(0);
      assert.deepEqual(browser.events, beforeTimers);
    });
  }
});
