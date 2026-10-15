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
const menuItems: ModelSelectGroupItem[] = query.has("compact")
  ? [
      "Step-5-Preview",
      "Deepseek-V4.1-Flash",
      "Deepseek-V4.1-Flash (SG)",
      "GPT-6-Sol",
      "GPT-6-Luna",
      "GPT-5.6-Terra",
      "GPT-5.6-Luna",
      "GPT-5.5",
      ...Array.from({ length: 10 }, (_, index) => `Model ${index + 1}`),
    ].map((name, index) => {
      const multiplier = [0, 0, 0.03, 1.33, 0.07, 1.39, 0.14, 3.31][index % 8]!;
      return {
        key: `compact-${index}`,
        value: `compact-${index}`,
        name,
        supportsVisionInput: true,
        billing: { kind: "multiplier", multiplier, ...(multiplier === 0 ? { free: true } : {}) },
      };
    })
  : items;
if (query.has("promotion"))
  menuItems.push({
    key: "promotion",
    value: "promotion",
    name: "Promotion model",
    supportsVisionInput: true,
    billing: {
      kind: "multiplier",
      multiplier: 0.29,
      originalMultiplier: 123.4567,
      validUntil: "2099-01-01T00:00:00Z",
    },
  });
function Fixture() {
  const [value, setValue] = useState(query.has("compact") ? "compact-1" : "exact-short");
  return (
    <main className="p-4">
      <ModelConfigSelect
        modelGroups={[{ key: "oauth", label: "OAuth", items: menuItems }]}
        normalizedValue={value}
        triggerLabel="Models"
        showManageModelsAction={false}
        lockReasonMessage="Locked"
        isItemLocked={(itemValue) => query.has("locked") && itemValue === "compact-1"}
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
