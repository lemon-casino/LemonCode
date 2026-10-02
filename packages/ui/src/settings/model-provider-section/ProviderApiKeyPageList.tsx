import type { ProviderApiKey } from "@lcode/provider";
import {
  ChevronsLeftIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsRightIcon,
  Trash2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import type { getProviderApiKeyPage } from "./providerApiKeyList.js";
import type { ProviderApiKeyProbeState } from "./useProviderApiKeyManager.js";

export function ProviderApiKeyPageList({
  draft,
  page,
  setPage,
  visible,
  disabled,
  getProbeState,
  updateKey,
  removeKey,
}: {
  draft: readonly ProviderApiKey[];
  page: ReturnType<typeof getProviderApiKeyPage>;
  setPage: (page: number) => void;
  visible: boolean;
  disabled: boolean;
  getProbeState: (id: string) => ProviderApiKeyProbeState | undefined;
  updateKey: (index: number, patch: Partial<ProviderApiKey>) => void;
  removeKey: (index: number) => void;
}) {
  const { intl } = useLCodeIntl();
  return (
    <div className="space-y-3">
      <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
        {draft.length === 0 ? (
          <div className="rounded-xl border border-border bg-surface px-4 py-6 text-center text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.modelProvider.apiKeyManager.empty" })}
          </div>
        ) : (
          draft.slice(page.start, page.end).map((key, offset) => {
            const index = page.start + offset;
            const status = getProbeState(key.id);
            return (
              <div
                key={key.id}
                data-api-key-row
                className="grid grid-cols-1 items-center gap-2 rounded-xl border border-border bg-surface p-3 sm:grid-cols-[minmax(7rem,0.35fr)_minmax(12rem,1fr)_auto_auto]"
              >
                <Input
                  size="lg"
                  value={key.label ?? ""}
                  aria-label={intl.formatMessage(
                    { id: "settings.modelProvider.apiKeyManager.label" },
                    { index: index + 1 },
                  )}
                  placeholder={`API Key ${index + 1}`}
                  disabled={disabled}
                  onChange={(event) => updateKey(index, { label: event.target.value })}
                />
                <div className="min-w-0">
                  <Input
                    size="lg"
                    type={visible ? "text" : "password"}
                    value={key.apiKey}
                    className="font-mono"
                    aria-label={`API Key ${index + 1}`}
                    disabled={disabled}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => updateKey(index, { apiKey: event.target.value })}
                  />
                  {status ? (
                    <p
                      className={`mt-1 text-ui-sm ${status === "valid" ? "text-success" : status === "invalid" ? "text-destructive" : "text-foreground-subtle"}`}
                    >
                      {intl.formatMessage({
                        id: `settings.modelProvider.apiKeyManager.status.${status}`,
                      })}
                    </p>
                  ) : null}
                </div>
                <Switch
                  checked={key.enabled !== false}
                  disabled={disabled}
                  aria-label={intl.formatMessage({
                    id: "settings.modelProvider.apiKeyManager.enabled",
                  })}
                  onCheckedChange={(enabled) => updateKey(index, { enabled })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={disabled}
                  aria-label={intl.formatMessage({ id: "common.delete" })}
                  onClick={() => removeKey(index)}
                >
                  <Trash2Icon />
                </Button>
              </div>
            );
          })
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-ui-sm text-foreground-subtle" role="status">
          {intl.formatMessage(
            { id: "settings.modelProvider.apiKeyManager.pagination.summary" },
            page,
          )}
        </p>
        <nav
          className="flex items-center gap-1"
          aria-label={intl.formatMessage({
            id: "settings.modelProvider.apiKeyManager.pagination.label",
          })}
        >
          {(
            [
              ["first", ChevronsLeftIcon, 1, page.page === 1],
              ["previous", ChevronLeftIcon, page.page - 1, page.page === 1],
            ] as const
          ).map(([name, Icon, target, boundary]) => (
            <Button
              key={name}
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={disabled || boundary}
              onClick={() => setPage(target)}
              aria-label={intl.formatMessage({
                id: `settings.modelProvider.apiKeyManager.pagination.${name}`,
              })}
            >
              <Icon />
            </Button>
          ))}
          <Input
            key={page.page}
            type="number"
            min={1}
            max={page.pages}
            defaultValue={page.page}
            className="w-16 text-center"
            disabled={disabled}
            aria-label={intl.formatMessage({
              id: "settings.modelProvider.apiKeyManager.pagination.jump",
            })}
            onBlur={(event) => {
              const target = Math.min(
                page.pages,
                Math.max(1, Math.trunc(Number(event.target.value)) || 1),
              );
              event.currentTarget.value = String(target);
              setPage(target);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
          />
          {(
            [
              ["next", ChevronRightIcon, page.page + 1, page.page === page.pages],
              ["last", ChevronsRightIcon, page.pages, page.page === page.pages],
            ] as const
          ).map(([name, Icon, target, boundary]) => (
            <Button
              key={name}
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={disabled || boundary}
              onClick={() => setPage(target)}
              aria-label={intl.formatMessage({
                id: `settings.modelProvider.apiKeyManager.pagination.${name}`,
              })}
            >
              <Icon />
            </Button>
          ))}
        </nav>
      </div>
    </div>
  );
}
