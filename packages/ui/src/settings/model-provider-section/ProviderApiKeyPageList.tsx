import { ProviderApiKeyRow } from "./ProviderApiKeyRow.js";
import type { ProviderApiKey } from "@lcode/provider";
import {
  ChevronsLeftIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsRightIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import type { getProviderApiKeyPage } from "./providerApiKeyList.js";
import type { ProviderApiKeyProbeState } from "./useProviderApiKeyManager.js";

export function ProviderApiKeyPageList({
  draft,
  page,
  setPage,
  visible,
  disabled,
  navigationDisabled = disabled,
  getProbeState,
  updateKey,
  removeKey,
}: {
  draft: readonly ProviderApiKey[];
  page: ReturnType<typeof getProviderApiKeyPage>;
  setPage: (page: number) => void;
  visible: boolean;
  disabled: boolean;
  navigationDisabled?: boolean;
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
          draft
            .slice(page.start, page.end)
            .map((key, offset) => (
              <ProviderApiKeyRow
                key={key.id}
                entry={key}
                index={page.start + offset}
                status={getProbeState(key.id)}
                visible={visible}
                disabled={disabled}
                updateKey={updateKey}
                removeKey={removeKey}
              />
            ))
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
              disabled={navigationDisabled || boundary}
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
            disabled={navigationDisabled}
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
              disabled={navigationDisabled || boundary}
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
