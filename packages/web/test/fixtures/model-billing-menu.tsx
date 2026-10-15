import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ModelConfigSelect, type ModelSelectGroupItem } from "@/ModelConfigSelect.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { applyTheme } from "@/useTheme.js";
import "@/styles.css";

const query = new URLSearchParams(location.search);
applyTheme(query.get("theme") === "light" ? "zai-light" : "zai-dark");
const items: ModelSelectGroupItem[] = [
  {
    key: "short",
    value: "exact-short",
    name: "Short",
    supportsVisionInput: true,
    billing: { kind: "multiplier", multiplier: 0.25 },
  },
  {
    key: "long",
    value: "exact-long",
    modelId: "id-long",
    name: "A very long friendly model name that must fit on a phone",
    supportsVisionInput: true,
    billing: { kind: "multiplier", multiplier: 0.71 },
  },
  {
    key: "free",
    value: "exact-free",
    name: "Free model",
    billing: { kind: "multiplier", multiplier: 0, free: true },
  },
  { key: "unknown", value: "exact-unknown", name: "Unknown price", supportsVisionInput: true },
  {
    key: "credits",
    value: "exact-credits",
    name: "AI Credits",
    billing: { kind: "token-credits", input: 0.3, output: 1.2, batchSize: 1000 },
  },
  {
    key: "expired",
    value: "exact-expired",
    name: "Expired free promotion",
    billing: {
      kind: "multiplier",
      multiplier: 0,
      free: true,
      originalMultiplier: 1.5,
      validUntil: "2020-01-01T00:00:00Z",
    },
  },
];
function Fixture() {
  const [value, setValue] = useState("exact-short");
  return (
    <main className="p-4">
      <ModelConfigSelect
        modelGroups={[{ key: "oauth", label: "OAuth", items }]}
        normalizedValue={value}
        triggerLabel="Models"
        showManageModelsAction={false}
        lockReasonMessage="Locked"
        isItemLocked={() => false}
        onValueChange={setValue}
        showProviderLevel={query.has("nested")}
      />
      <output data-testid="selected-model">{value}</output>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <LCodeIntlProvider initialLocale={query.get("locale") === "en-US" ? "en-US" : "zh-CN"}>
    <Fixture />
  </LCodeIntlProvider>,
);
