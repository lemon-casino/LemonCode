import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { GoalEvidenceSummaryView } from "./GoalEvidenceSummary.js";

test("strict evidence exposes stale/missing facts without claiming goal completion", () => {
  const html = renderToStaticMarkup(
    <LCodeIntlProvider>
      <GoalEvidenceSummaryView
        summary={{
          policy: "strict",
          contractHash: "a".repeat(64),
          outcome: "incomplete",
          requirements: [
            { requirementId: "unit", status: "passed" },
            { requirementId: "integration", status: "stale" },
            { requirementId: "lint", status: "not-run" },
          ],
        }}
      />
    </LCodeIntlProvider>,
  );
  assert.match(html, /data-evidence-status="stale"/);
  assert.match(html, /data-evidence-status="not-run"/);
  assert.match(html, /1\/3/);
  assert.match(html, /integration/);
  assert.doesNotMatch(html, /a{64}/);
});

test("legacy snapshots without evidence retain their existing surface", () => {
  assert.equal(
    renderToStaticMarkup(
      <LCodeIntlProvider>
        <GoalEvidenceSummaryView />
      </LCodeIntlProvider>,
    ),
    "",
  );
});
