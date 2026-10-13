import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { CredentialJsonTextarea } from "./CredentialJsonTextarea.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

const FILE_LIMIT = 4 * 1024 * 1024;
const TOTAL_LIMIT = 8 * 1024 * 1024;

export function ProviderCredentialImport({
  disabled,
  onImport,
}: {
  disabled: boolean;
  onImport: (files: string) => Promise<void>;
}) {
  const { intl } = useLCodeIntl();
  const m = (key: string) => intl.formatMessage({ id: `settings.oauth.import.${key}` });
  const [files, setFiles] = useState<File[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<"fileTooLarge" | "totalTooLarge" | "readFailed" | null>(null);
  const [reading, setReading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const checkSize = (selected: readonly File[], pasted: string) => {
    const textBytes = new TextEncoder().encode(pasted).byteLength;
    if (selected.some((file) => file.size > FILE_LIMIT) || textBytes > FILE_LIMIT)
      return "fileTooLarge";
    if (selected.reduce((size, file) => size + file.size, textBytes) > TOTAL_LIMIT)
      return "totalTooLarge";
    return null;
  };
  const submit = async () => {
    if (disabled || reading) return;
    const sizeError = checkSize(files, text);
    setError(sizeError);
    if (sizeError) return;
    const current = ++generation.current;
    setReading(true);
    try {
      const selected = await Promise.all(
        files.map(async (file) => ({ name: file.name, content: await file.text() })),
      );
      if (current !== generation.current) return;
      if (text.trim()) selected.push({ name: m("pasted"), content: text });
      if (!selected.length) return;
      // 选择文件只做大小检查和读取；供应商格式解析、验证、去重和保存统一交给 Host。
      setFiles([]);
      setText("");
      await onImport(JSON.stringify(selected));
    } catch {
      if (current === generation.current) setError("readFailed");
    } finally {
      if (current === generation.current) setReading(false);
    }
  };
  return (
    <div className="min-w-0 space-y-3">
      <p className="text-ui-sm text-foreground-subtle">{m("limits")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || reading}
          onClick={() => input.current?.click()}
        >
          {m("choose")}
        </Button>
        <input
          ref={input}
          type="file"
          className="hidden"
          accept=".json,.txt,application/json,text/plain"
          multiple
          aria-label={m("choose")}
          disabled={disabled || reading}
          onChange={(event) => {
            const selected = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            const nextError = checkSize(selected, text);
            setError(nextError);
            setFiles(nextError ? [] : selected);
          }}
        />
        <span className="min-w-0 break-words text-ui-sm text-foreground-subtle">
          {files.map((file) => file.name).join(", ")}
        </span>
      </div>
      <CredentialJsonTextarea
        label={m("paste")}
        value={text}
        onChange={setText}
        disabled={disabled || reading}
      />
      {error ? (
        <p role="alert" className="text-ui-base text-destructive">
          {m(error)}
        </p>
      ) : null}
      <Button
        type="button"
        variant="outline"
        disabled={disabled || reading || (!files.length && !text.trim())}
        onClick={() => void submit()}
      >
        {m(reading ? "reading" : "submit")}
      </Button>
    </div>
  );
}
