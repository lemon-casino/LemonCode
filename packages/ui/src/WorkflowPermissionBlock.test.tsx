import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { workflowScriptFingerprint } from "@lcode/shared/lcode-protocol-v4";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { WorkflowOrchestrationAdvice } from "./components/workflow-timeline/WorkflowOrchestrationAdvice.js";

const script = 'phase("Read");\nawait agent("Reader").ask("read");\nreturn "done";';
const advice = {
  scriptHash: workflowScriptFingerprint(script),
  items: [
    {
      code: "await-before-later-asks",
      line: 2,
      column: 1,
      waitingOn: [{ line: 2, column: 7 }],
      delayed: [{ line: 3, column: 1 }],
      message: "UNTRUSTED MESSAGE MUST NOT BE DISPLAYED",
    },
  ],
};
function render(raw: unknown, locale: "zh-CN" | "en-US" = "zh-CN") {
  return renderToStaticMarkup(
    <LCodeIntlProvider initialLocale={locale}>
      <WorkflowOrchestrationAdvice raw={raw} />
    </LCodeIntlProvider>,
  );
}

test("permission block uses the same bounded advice presentation", async () => {
  const source = await readFile(new URL("./WorkflowPermissionBlock.tsx", import.meta.url), "utf8");
  assert.match(source, /<WorkflowOrchestrationAdvice raw=\{request\.raw\}/);
});

test("confirmation advice is nonblocking, localized and tied to the exact raw script", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const html = render({ script, orchestration_advice: advice }, locale);
    assert.match(html, /data-testid="workflow-orchestration-advice"/);
    assert.match(html, locale === "zh-CN" ? /不影响运行确认/ : /does not block confirmation/);
    assert.match(html, /2:1/);
    assert.match(html, /3:1/);
    assert.match(html, /FIFO/);
    assert.doesNotMatch(html, /UNTRUSTED MESSAGE|disabled=/);
  }
});

test("missing, mismatched or malformed advice never leaks into confirmation", () => {
  for (const raw of [
    { script },
    { script: `${script}\n// edited`, orchestration_advice: advice },
    { script, orchestration_advice: { ...advice, items: [{ ...advice.items[0], line: 0 }] } },
  ]) {
    assert.doesNotMatch(render(raw), /workflow-orchestration-advice/);
  }
});
