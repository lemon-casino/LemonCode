/// <reference types="vite/client" />
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { LCodePermissionRequest } from "@lcode/shared";
import { PermissionDialog } from "@/PermissionDialog.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import "@lcode/ui/styles.css";

function Fixture() {
  const [answer, setAnswer] = useState("");
  const query = new URLSearchParams(location.search);
  const retained = query.get("temporary") !== "1";
  const request = {
    type: "permission_request",
    taskId: "preview-fixture-task",
    traceId: "preview-fixture-trace",
    requestId: "preview-fixture-permission",
    description: "Start temporary web preview",
    kind: "execute",
    title: "Bash",
    options: [
      {
        optionId: "allow_once",
        kind: "allowOnce",
        name: "Allow once",
        response: { decision: "allow" },
      },
      {
        optionId: "deny_once",
        kind: "rejectOnce",
        name: "Deny once",
        response: { decision: "deny" },
      },
    ],
    raw: {
      toolName: "Bash",
      input: {
        command: "pnpm dev",
        description: "Start temporary web preview",
        run_in_background: true,
        keep_alive_after_task: retained ? (query.get("string") === "1" ? "true" : true) : false,
      },
    },
  } as LCodePermissionRequest;
  return (
    <LCodeIntlProvider initialLocale={query.get("lang") === "en" ? "en-US" : "zh-CN"}>
      <TooltipProvider>
        <main className="mx-auto max-w-2xl p-4">
          {answer ? (
            <output aria-label="审批结果">{answer}</output>
          ) : (
            <PermissionDialog
              request={request}
              workspacePath="preview-fixture"
              onRespond={(_requestId, option) => setAnswer(option.response.decision)}
            />
          )}
        </main>
      </TooltipProvider>
    </LCodeIntlProvider>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<Fixture />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
