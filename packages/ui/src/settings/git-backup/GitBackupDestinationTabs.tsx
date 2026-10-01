import { Cloud, Server } from "lucide-react";
import { getGitBackupDestinationSelection, type GitBackupWorkspaceTarget } from "@lcode/services";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import type { useGitBackup } from "@/hooks/useGitBackup.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { GitBackupDestinationPanel } from "./GitBackupDestinationPanel.js";

export function GitBackupDestinationTabs({
  backup,
  target,
  formId,
}: {
  backup: ReturnType<typeof useGitBackup>;
  target: GitBackupWorkspaceTarget | null;
  formId: string;
}) {
  const { intl } = useLCodeIntl();
  const { config, status, provider } = backup;
  if (!config) return null;
  const selection = getGitBackupDestinationSelection(config);
  const switchingDisabled = Boolean(backup.operation && backup.operation !== "test");
  return (
    <section className="min-w-0 space-y-3 border-t border-border pt-4">
      <h3 className="text-ui-base font-medium">
        {intl.formatMessage({ id: "settings.gitBackup.destinations" })}
      </h3>
      <p className="text-ui-caption text-foreground-subtle">
        {intl.formatMessage({ id: "settings.gitBackup.destinations.note" })}
      </p>
      <Tabs
        value={provider}
        onValueChange={(value) => {
          // 页签只切换展示；不能把单选导航变成互斥目的地开关，草稿仍由同一个 hook 持有。
          if (!switchingDisabled && (value === "oss" || value === "minio"))
            backup.selectProvider(value);
        }}
        className="min-w-0 gap-3"
      >
        <TabsList
          className="grid w-full grid-cols-2 gap-1 rounded-xl bg-card p-1 group-data-horizontal/tabs:h-auto"
          aria-label={intl.formatMessage({ id: "settings.gitBackup.destinations" })}
        >
          {(["oss", "minio"] as const).map((destination) => {
            const destinationStatus = status?.destinations?.[destination];
            const configured =
              destinationStatus?.configured ?? (destination === "oss" && status?.configured);
            const attention = Boolean(
              destinationStatus?.error || (config[destination] && status && !configured),
            );
            const summary = !config[destination]
              ? "unconfigured"
              : attention
                ? "attention"
                : selection[destination]
                  ? "included"
                  : "excluded";
            const Icon = destination === "oss" ? Cloud : Server;
            return (
              <TabsTrigger
                key={destination}
                value={destination}
                disabled={switchingDisabled}
                data-testid={`git-backup-tab-${destination}`}
                className="h-auto min-w-0 flex-col items-start gap-1 rounded-lg px-3 py-2 text-left whitespace-normal data-[state=active]:border-border data-[state=active]:bg-background data-[state=active]:text-foreground"
              >
                <span className="flex min-w-0 items-center gap-2 text-ui-base font-medium">
                  <Icon className="size-4 shrink-0" aria-hidden="true" />
                  {intl.formatMessage({ id: `settings.gitBackup.provider.${destination}` })}
                </span>
                <span
                  className={`text-ui-caption font-normal ${attention ? "text-warning" : "text-foreground-subtle"}`}
                >
                  {intl.formatMessage({ id: `settings.gitBackup.destinationSummary.${summary}` })}
                </span>
              </TabsTrigger>
            );
          })}
        </TabsList>
        {(["oss", "minio"] as const).map((destination) => (
          <TabsContent
            key={destination}
            value={destination}
            className="min-w-0"
            data-testid={`git-backup-panel-${destination}`}
          >
            {provider === destination ? (
              <GitBackupDestinationPanel backup={backup} target={target} formId={formId} />
            ) : null}
          </TabsContent>
        ))}
      </Tabs>
    </section>
  );
}
