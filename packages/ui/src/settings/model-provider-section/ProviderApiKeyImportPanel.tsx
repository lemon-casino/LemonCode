import { useId, useRef, useState } from "react";
import { ClipboardPasteIcon, FileUpIcon, ImportIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function ProviderApiKeyImportPanel({
  disabled,
  importing,
  onImportText,
  onImportFiles,
  onImportClipboard,
}: {
  disabled: boolean;
  importing: boolean;
  onImportText: (source: string) => Promise<boolean>;
  onImportFiles: (files: File[]) => Promise<boolean>;
  onImportClipboard: () => Promise<boolean>;
}) {
  const { intl } = useZCodeIntl();
  const [source, setSource] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const hintId = useId();

  return (
    <div className="space-y-3 rounded-xl border border-dashed border-border bg-surface p-3">
      <div className="space-y-1">
        <label htmlFor={inputId} className="text-ui-base font-medium">
          {intl.formatMessage({ id: "settings.modelProvider.apiKeyManager.import.input" })}
        </label>
        <p id={hintId} className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.apiKeyManager.import.hint" })}
        </p>
      </div>
      <Textarea
        id={inputId}
        aria-describedby={hintId}
        className="max-h-40 min-h-24 overflow-y-auto rounded-lg font-mono text-mobile-input-safe md:text-ui-base"
        value={source}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        placeholder={intl.formatMessage({
          id: "settings.modelProvider.apiKeyManager.import.placeholder",
        })}
        onChange={(event) => setSource(event.target.value)}
        onPaste={(event) => {
          const pasted = event.clipboardData.getData("text");
          // 巨量文本不进入 DOM/受控输入状态，直接交后台解析，避免浏览器排版冻结。
          if (pasted.length > 64 * 1024) {
            event.preventDefault();
            void onImportText(pasted).then((success) => {
              if (success) setSource("");
            });
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          disabled={disabled || !source.trim()}
          onClick={async () => {
            if (await onImportText(source)) setSource("");
          }}
        >
          <ImportIcon data-icon="inline-start" />
          {intl.formatMessage({ id: "settings.modelProvider.apiKeyManager.import.apply" })}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={async () => {
            if (await onImportClipboard()) setSource("");
          }}
        >
          <ClipboardPasteIcon data-icon="inline-start" />
          {intl.formatMessage({ id: "settings.modelProvider.apiKeyManager.import.clipboard" })}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
        >
          <FileUpIcon data-icon="inline-start" />
          {intl.formatMessage({ id: "settings.modelProvider.apiKeyManager.import.file" })}
        </Button>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          accept=".txt,.json,.csv,.tsv,.log,text/*,application/json"
          multiple
          disabled={disabled}
          aria-label={intl.formatMessage({
            id: "settings.modelProvider.apiKeyManager.import.file",
          })}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            if (files.length > 0) void onImportFiles(files);
          }}
        />
        {importing ? (
          <p role="status" className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.modelProvider.apiKeyManager.import.reading" })}
          </p>
        ) : null}
      </div>
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "settings.modelProvider.apiKeyManager.import.dropHint" })}
      </p>
    </div>
  );
}
