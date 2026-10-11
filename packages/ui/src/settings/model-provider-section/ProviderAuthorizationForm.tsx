import { useState } from "react";
import type { ProviderAccountChannel, ProviderAccountField } from "@lcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import type { useProviderAccounts } from "@/hooks/useProviderAccounts.js";
import { getProviderAccountDependencyError } from "@/lib/providerAccountErrors.js";
import { ProviderCredentialImport } from "./ProviderCredentialImport.js";

export function ProviderAuthorizationForm({
  channel,
  accounts,
}: {
  channel: ProviderAccountChannel;
  accounts: ReturnType<typeof useProviderAccounts>;
}) {
  const { intl } = useLCodeIntl();
  const message = (key: string) => intl.formatMessage({ id: `settings.oauth.${key}` });
  const [methodId, setMethodId] = useState(channel.methods[0]?.id ?? "");
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [code, setCode] = useState("");
  const method = channel.methods.find((item) => item.id === methodId);
  const effectiveInputs = {
    ...Object.fromEntries(
      (method?.fields ?? [])
        .filter((field) => field.defaultValue !== undefined)
        .map((field) => [field.key, field.defaultValue!]),
    ),
    ...inputs,
  };
  const visibleFields =
    method?.fields?.filter(
      (field) => !field.condition || effectiveInputs[field.condition.key] === field.condition.value,
    ) ?? [];
  const attempt = accounts.authorization?.channelId === channel.id ? accounts.authorization : null;
  const pending = attempt?.status === "pending";
  const busy = accounts.busy !== null;
  const missingRequired = visibleFields.some(
    (field) => !field.optional && !effectiveInputs[field.key]?.trim(),
  );
  const selectedInputs = () =>
    Object.fromEntries(visibleFields.map((field) => [field.key, effectiveInputs[field.key] ?? ""]));
  if (!channel.methods.length)
    return (
      <p role="status" className="text-ui-base text-foreground-subtle">
        {message("noMethods")}
      </p>
    );

  return (
    <div className="space-y-3">
      {!pending ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!method || method.kind === "import" || busy || missingRequired) return;
            void accounts.start({
              channelId: channel.id,
              methodId: method.id,
              inputs: selectedInputs(),
            });
            setInputs({});
            setCode("");
          }}
        >
          <div className="flex flex-wrap gap-2">
            {(["import", "local"] as const).map((kind) => {
              const source = channel.methods.find((item) => item.kind === kind);
              return source ? (
                <Button
                  key={kind}
                  type="button"
                  size="sm"
                  variant={method?.kind === kind ? "secondary" : "outline"}
                  disabled={busy}
                  onClick={() => {
                    setMethodId(source.id);
                    setInputs({});
                    setCode("");
                    if (kind !== "local") return;
                    const defaults = Object.fromEntries(
                      (source.fields ?? [])
                        .filter((field) => field.defaultValue !== undefined)
                        .map((field) => [field.key, field.defaultValue!]),
                    );
                    const fields = (source.fields ?? []).filter(
                      (field) =>
                        !field.condition || defaults[field.condition.key] === field.condition.value,
                    );
                    // 无输入本机方法只需一次明确点击；有必填 profile 时仍先展示选择，不能猜账号。
                    if (fields.some((field) => !field.optional && !defaults[field.key]?.trim()))
                      return;
                    void accounts.start({
                      channelId: channel.id,
                      methodId: source.id,
                      inputs: Object.fromEntries(
                        fields.map((field) => [field.key, defaults[field.key] ?? ""]),
                      ),
                    });
                  }}
                >
                  {message(`source.${kind}`)}
                </Button>
              ) : null;
            })}
          </div>
          <label className="block space-y-1.5 text-ui-base">
            <span>{message("method")}</span>
            <Select
              value={methodId}
              onValueChange={(value) => {
                setMethodId(value);
                setInputs({});
              }}
              disabled={busy}
            >
              <SelectTrigger aria-label={message("method")} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {channel.methods.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          {method?.description ? (
            <p className="break-words text-ui-base text-foreground-subtle">{method.description}</p>
          ) : null}
          {visibleFields.map((field) => (
            <AuthorizationInput
              key={field.key}
              field={field}
              value={effectiveInputs[field.key] ?? ""}
              disabled={busy}
              onChange={(value) => setInputs((current) => ({ ...current, [field.key]: value }))}
            />
          ))}
          {method?.kind === "import" ? (
            <ProviderCredentialImport
              key={method.id}
              disabled={busy || missingRequired}
              onImport={async (files) => {
                await accounts.start({
                  channelId: channel.id,
                  methodId: method.id,
                  inputs: { ...selectedInputs(), files },
                });
                setInputs({});
              }}
            />
          ) : (
            <Button type="submit" variant="outline" disabled={busy || !method || missingRequired}>
              {message(
                accounts.busy === "authorize"
                  ? "starting"
                  : method?.kind === "local"
                    ? "readLocal"
                    : "start",
              )}
            </Button>
          )}
        </form>
      ) : (
        <div className="space-y-3" data-testid="oauth-authorization-pending">
          <p role="status" className="text-ui-base text-foreground-subtle">
            {message("waiting")}
          </p>
          {attempt.instructions ? (
            <p className="whitespace-pre-wrap break-words text-ui-base">{attempt.instructions}</p>
          ) : null}
          {attempt.url ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => accounts.openBrowser(attempt.url)}
            >
              {message("openBrowser")}
            </Button>
          ) : null}
          {attempt.method === "code" ? (
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (code.trim() && !busy) {
                  void accounts.complete(code.trim());
                  setCode("");
                }
              }}
            >
              <label className="block space-y-1.5 text-ui-base">
                <span>{message("code")}</span>
                <Input
                  aria-label={message("code")}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                />
              </label>
              <Button type="submit" variant="outline" disabled={busy || !code.trim()}>
                {message("complete")}
              </Button>
            </form>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={accounts.busy === "cancel"}
            onClick={() => void accounts.cancel()}
          >
            {message("cancel")}
          </Button>
        </div>
      )}
      {attempt?.status === "completed" && !attempt.results ? (
        <p role="status" className="text-ui-base text-foreground-subtle">
          {message("completed")}
        </p>
      ) : null}
      {attempt?.status === "failed" ? (
        <p role="alert" className="break-words text-ui-base text-destructive">
          {message(getProviderAccountDependencyError(attempt.error) ?? "authorizationFailed")}
        </p>
      ) : null}
      {attempt?.methodId === methodId && attempt.results ? (
        <ul
          className="space-y-2 text-ui-base"
          data-testid="oauth-import-results"
          aria-label={message("import.results")}
        >
          {attempt.results.map((result) => (
            <li
              key={result.index}
              className="min-w-0 break-words rounded-lg border border-border p-2"
            >
              <span>
                {result.label ??
                  intl.formatMessage(
                    { id: "settings.oauth.import.item" },
                    { index: result.index + 1 },
                  )}
              </span>
              {" · "}
              <span>{message(`import.${result.status}`)}</span>
              {result.error ? (
                <p className="text-ui-sm text-destructive">{message(`import.${result.error}`)}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function AuthorizationInput({
  field,
  value,
  onChange,
  disabled,
}: {
  field: ProviderAccountField;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <label className="block space-y-1.5 text-ui-base">
      <span>{field.label}</span>
      {field.type === "select" ? (
        <Select value={value} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger className="w-full" aria-label={field.label}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {field.options?.map((option) => (
              <SelectItem key={option.value} value={option.value} textValue={option.label}>
                {option.label}
                {option.hint ? (
                  <span className="ml-2 text-ui-sm text-foreground-subtle">{option.hint}</span>
                ) : null}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          type={field.type}
          placeholder={field.placeholder}
          aria-label={field.label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          required={!field.optional}
          autoComplete="off"
          spellCheck={false}
        />
      )}
    </label>
  );
}
