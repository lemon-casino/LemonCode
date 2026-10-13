import { useState } from "react";
import { createRoot } from "react-dom/client";
import { toolCallRowSchema, type ToolCallRow } from "@lcode/shared/lcode-protocol-v4";
import { LCodeIntlProvider, useLCodeIntl } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { EvalWorkflowSnippetToolCallBlock } from "@/ToolCallBlocks/renderers/eval-workflow-snippet.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import "@lcode/ui/styles.css";

declare global {
  interface Window {
    __snippetRows: ToolCallRow[];
    __snippetExecutions: number;
  }
}

const displayModel: ToolCallBlockRenderContext["displayModel"] = {
  inlinePreview: { type: "none" },
  planResult: null,
  viewerSource: null,
  viewerLabelId: "codeViewer.viewCode",
  showSummaryFileLink: false,
  showInput: false,
  showOutput: false,
  showKind: false,
};
const rows = window.__snippetRows.map((row) => toolCallRowSchema.parse(row));
const controlClass = "rounded-lg border border-border px-3 py-1 text-ui-sm";

function App() {
  const { locale, setLocale } = useLCodeIntl();
  const [dark, setDark] = useState(false);
  return (
    <main className="mx-auto max-w-3xl space-y-5 p-4">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={controlClass}
          onClick={() => setLocale(locale === "zh-CN" ? "en-US" : "zh-CN")}
        >
          {locale}
        </button>
        <button
          type="button"
          className={controlClass}
          onClick={() => {
            const next = !dark;
            document.documentElement.className = next ? "dark theme-zai-dark" : "theme-zai-light";
            setDark(next);
          }}
        >
          {dark ? "Light" : "Dark"}
        </button>
        <output data-testid="snippet-executions" className="text-ui-sm">
          {window.__snippetExecutions}
        </output>
      </div>
      {rows.map((row, index) => (
        <section
          key={row.toolCallId}
          data-testid={`snippet-case-${index}`}
          className="min-w-0 rounded-xl border border-border p-3"
        >
          <EvalWorkflowSnippetToolCallBlock
            toolCallNode={toolCallRowToLegacyNode(row)}
            workspacePath="/fixture"
            displayModel={displayModel}
            viewerSource={null}
            rawFileSummaries={[]}
            isRunning={false}
            statusLabel={row.status}
            errorText={row.error?.message}
            childToolList={null}
            theme={dark ? "zai-dark" : "zai-light"}
          />
        </section>
      ))}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <LCodeIntlProvider initialLocale="zh-CN">
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </LCodeIntlProvider>,
);
