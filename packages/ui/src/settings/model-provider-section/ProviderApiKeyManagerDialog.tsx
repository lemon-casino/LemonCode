import { useId } from "react";
import {
  EyeIcon,
  EyeOffIcon,
  ImportIcon,
  PlusIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { ProviderApiKeyImportPanel } from "./ProviderApiKeyImportPanel.js";
import { ProviderApiKeyPageList } from "./ProviderApiKeyPageList.js";
import {
  useProviderApiKeyManager,
  type ProviderApiKeyManagerProps,
} from "./useProviderApiKeyManager.js";

export function ProviderApiKeyManagerDialog(props: ProviderApiKeyManagerProps) {
  const { intl } = useLCodeIntl();
  const manager = useProviderApiKeyManager(props);
  const importPanelId = useId();
  const disabled = manager.busy !== null || !manager.loaded;
  return (
    <Dialog open={props.open} onOpenChange={(next) => manager.canClose && props.onOpenChange(next)}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl"
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = disabled ? "none" : "copy";
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.stopPropagation();
          const files = Array.from(event.dataTransfer.files);
          if (files.length > 0) void manager.importKeys(files);
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: "settings.modelProvider.apiKeyManager.title" })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "settings.modelProvider.apiKeyManager.description" })}
          </DialogDescription>
        </DialogHeader>
        {manager.busy === "load" ? (
          <p role="status" className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "common.loading" })}
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={manager.addKey} disabled={disabled}>
              <PlusIcon data-icon="inline-start" />
              {intl.formatMessage({ id: "settings.modelProvider.apiKeyManager.add" })}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              aria-expanded={manager.importOpen}
              aria-controls={importPanelId}
              onClick={() => manager.setImportOpen((current) => !current)}
            >
              <ImportIcon data-icon="inline-start" />
              {intl.formatMessage({ id: "settings.modelProvider.apiKeyManager.import.title" })}
            </Button>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={intl.formatMessage({
              id: manager.visible
                ? "settings.modelProvider.hideApiKey"
                : "settings.modelProvider.showApiKey",
            })}
            onClick={() => manager.setVisible((current) => !current)}
          >
            {manager.visible ? <EyeOffIcon /> : <EyeIcon />}
          </Button>
        </div>
        {manager.importOpen ? (
          <div id={importPanelId} key={props.scopeKey}>
            <ProviderApiKeyImportPanel
              disabled={disabled}
              importing={manager.busy === "import"}
              onImportText={manager.importKeys}
              onImportFiles={manager.importKeys}
              onImportClipboard={() => manager.importKeys({ clipboard: true })}
            />
          </div>
        ) : null}
        {manager.importSummary ? (
          <p role="status" className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage(
              { id: "settings.modelProvider.apiKeyManager.import.summary" },
              manager.importSummary,
            )}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || manager.invalidCount === 0}
            onClick={() => void manager.removeInvalid()}
          >
            <Trash2Icon data-icon="inline-start" />
            {intl.formatMessage(
              { id: "settings.modelProvider.apiKeyManager.removeInvalid" },
              { count: manager.invalidCount },
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-destructive"
            disabled={disabled || manager.draft.length === 0}
            onClick={manager.removeAll}
          >
            <Trash2Icon data-icon="inline-start" />
            {intl.formatMessage({ id: "settings.modelProvider.apiKeyManager.removeAll" })}
          </Button>
        </div>
        <ProviderApiKeyPageList
          draft={manager.draft}
          page={manager.page}
          setPage={manager.setPage}
          visible={manager.visible}
          disabled={disabled}
          navigationDisabled={disabled && manager.busy !== "probe"}
          getProbeState={manager.getProbeState}
          updateKey={manager.updateKey}
          removeKey={manager.removeKey}
        />
        {manager.probeProgress ? (
          <div
            className="space-y-1 text-ui-sm text-foreground-subtle"
            role="status"
            data-api-key-probe-progress
          >
            <p>
              {intl.formatMessage(
                { id: `settings.modelProvider.apiKeyManager.probe.${manager.probeProgress.phase}` },
                manager.probeProgress,
              )}
            </p>
            <p>
              {intl.formatMessage(
                { id: "settings.modelProvider.apiKeyManager.probe.counts" },
                manager.probeProgress,
              )}
            </p>
          </div>
        ) : null}
        {manager.error ? (
          <p role="alert" className="text-ui-sm text-destructive">
            {manager.error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => props.onOpenChange(false)}
            disabled={!manager.canClose}
          >
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          {manager.busy === "probe" ? (
            <Button
              type="button"
              variant="secondary"
              onClick={manager.stopProbe}
              disabled={
                manager.probeProgress?.phase === "stopping" ||
                manager.probeProgress?.phase === "finishing" ||
                manager.probeProgress?.phase === "stopped" ||
                manager.probeProgress?.phase === "complete"
              }
            >
              {intl.formatMessage({ id: "settings.modelProvider.apiKeyManager.probe.stop" })}
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
              onClick={() => void manager.probe()}
              disabled={disabled}
            >
              <ShieldCheckIcon data-icon="inline-start" />
              {intl.formatMessage({ id: "settings.modelProvider.apiKeyManager.probe" })}
            </Button>
          )}
          <Button type="button" onClick={() => void manager.save()} disabled={disabled}>
            {intl.formatMessage({ id: "common.save" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
