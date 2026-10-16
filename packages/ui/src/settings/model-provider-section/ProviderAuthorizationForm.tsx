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
import { CredentialJsonTextarea } from "./CredentialJsonTextarea.js";
import { ProviderAuthorizationDiagnostic } from "./ProviderAuthorizationDiagnostic.js";
import {
  localizeAuthorizationChannel,
  localizeAuthorizationInstructions,
} from "./providerAuthorizationCopy.js";

export function ProviderAuthorizationForm({
  channel,
  accounts,
}: {
  channel: ProviderAccountChannel;
  accounts: ReturnType<typeof useProviderAccounts>;
}) {
  const { intl, locale } = useLCodeIntl();
  const message = (key: string) => intl.formatMessage({ id: `settings.oauth.${key}` });
  const [methodId, setMethodId] = useState(channel.methods[0]?.id ?? "");
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [code, setCode] = useState("");
  const displayChannel = localizeAuthorizationChannel(channel, locale, intl);
  const method = displayChannel.methods.find((item) => item.id === methodId);
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
  const instructions = localizeAuthorizationInstructions(
    channel.id,
    displayChannel.methods.find((item) => item.id === attempt?.methodId),
    attempt?.instructions,
    locale,
    intl,
  );
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
          <div className="flex min-w-0 items-end gap-2" data-testid="oauth-authorization-controls">
            {/* 原flex-1将选择框撑满整行；使用常规宽度并允许窄屏收缩，保持按钮紧邻和对齐。 */}
            <label className="flex w-72 min-w-0 flex-col gap-1.5 text-ui-base">
              <span>{message("method")}</span>
              <Select
                value={methodId}
                onValueChange={(value) => {
                  setMethodId(value);
                  setInputs({});
                }}
                disabled={busy}
              >
                <SelectTrigger
                  aria-label={message("method")}
                  className="w-full min-w-0 [&>span]:truncate"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {displayChannel.methods.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            {method?.kind !== "import" ? (
              <Button
                type="submit"
                variant="outline"
                className="shrink-0"
                disabled={busy || !method || missingRequired}
              >
                {message(
                  accounts.busy === "authorize"
                    ? "starting"
                    : method?.kind === "local"
                      ? "readLocal"
                      : "start",
                )}
              </Button>
            ) : null}
          </div>
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
          ) : null}
        </form>
      ) : (
        <div className="space-y-3" data-testid="oauth-authorization-pending">
          <p role="status" className="text-ui-base text-foreground-subtle">
            {message("waiting")}
          </p>
          {instructions ? (
            <p className="whitespace-pre-wrap break-words text-ui-base">{instructions}</p>
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
      {attempt?.diagnostic ? (
        <ProviderAuthorizationDiagnostic diagnostic={attempt.diagnostic} />
      ) : null}
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
  // 凭据 JSON 原先复用单行密码框，粘贴时换行被吞掉，无法逐行查看和修改。
  if (field.format === "json")
    return (
      <CredentialJsonTextarea
        label={field.label}
        value={value}
        onChange={onChange}
        disabled={disabled}
        required={!field.optional}
        placeholder={field.placeholder}
        secret={field.type === "password"}
      />
    );
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
