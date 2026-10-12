import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { useProviderAccounts } from "@/hooks/useProviderAccounts.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { ProviderAccountManager, ProviderLoginAuthorization } from "./ProviderAccountsPanel.js";
import { ProviderProxyEditor } from "@/settings/ProviderProxyEditor.js";

type ModelEditor = (listModels: () => Promise<readonly string[]>) => ReactNode;

/** 已添加供应商在右侧编辑；新增弹窗复用相同内容和账号服务。 */
export function ProviderAccountsDetails({
  channelId,
  title,
  modelEditor,
}: {
  channelId: string;
  title: string;
  modelEditor: ModelEditor;
}) {
  const accounts = useProviderAccounts();
  return (
    <section className="min-w-0 space-y-4" data-testid="oauth-provider-details">
      <h2 className="text-ui-lg font-medium">{title}</h2>
      <ProviderAccountsContent
        channelId={channelId}
        accounts={accounts}
        modelEditor={modelEditor}
      />
    </section>
  );
}

export function ProviderAccountsContent({
  channelId,
  accounts,
  modelEditor,
}: {
  channelId: string;
  accounts: ReturnType<typeof useProviderAccounts>;
  modelEditor?: ModelEditor;
}) {
  const { intl } = useLCodeIntl();
  const [tab, setTab] = useState("authorization");
  const [refreshingModels, setRefreshingModels] = useState(false);
  const listModels = async () => {
    setRefreshingModels(true);
    try {
      // OAuth 目录来自当前 Host 账号 owner，不走 API key 的占位地址查询。
      const views = await Promise.all(
        (accounts.view?.accounts ?? [])
          .filter((account) => account.channelId === channelId)
          .map((account) => accounts.refreshModels(account.connectionId)),
      );
      const latest = views.reduce<(typeof views)[number]>(
        (current, next) =>
          next && (!current || next.revision > current.revision) ? next : current,
        undefined,
      );
      if (!latest) throw new Error(intl.formatMessage({ id: "settings.oauth.actionError" }));
      return [
        ...new Set(
          latest.accounts
            .filter((account) => account.channelId === channelId && account.enabled)
            .flatMap((account) => account.models.map((model) => model.id)),
        ),
      ];
    } finally {
      setRefreshingModels(false);
    }
  };
  return (
    <div className="min-w-0 space-y-4">
      <ProviderProxyEditor channelId={channelId} />
      <Tabs value={tab} onValueChange={setTab} className="min-w-0 gap-4">
        {/* 通用页签的 flex-1 会拉满整行；这里限制总宽，小屏等分并允许长标签换行。 */}
        <TabsList
          className="grid h-auto w-full max-w-sm grid-cols-3"
          aria-label={intl.formatMessage({ id: "settings.oauth.manageAccounts" })}
        >
          <TabsTrigger value="authorization" className="h-full min-w-0 whitespace-normal">
            <span className="min-w-0 break-words">
              {intl.formatMessage({ id: "settings.oauth.authorizationTab" })}
            </span>
          </TabsTrigger>
          <TabsTrigger value="models" className="h-full min-w-0 whitespace-normal">
            <span className="min-w-0 break-words">
              {intl.formatMessage({ id: "settings.oauth.modelSettings" })}
            </span>
          </TabsTrigger>
          <TabsTrigger value="accounts" className="h-full min-w-0 whitespace-normal">
            <span className="min-w-0 break-words">
              {intl.formatMessage({ id: "settings.oauth.accounts" })}
            </span>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="authorization" forceMount hidden={tab !== "authorization"}>
          <ProviderLoginAuthorization channelId={channelId} accounts={accounts} />
        </TabsContent>
        <TabsContent value="accounts" forceMount hidden={tab !== "accounts"}>
          <ProviderAccountManager channelId={channelId} accounts={accounts} />
        </TabsContent>
        <TabsContent
          value="models"
          forceMount
          hidden={tab !== "models"}
          className="min-w-0 space-y-3"
        >
          <Button
            size="sm"
            variant="outline"
            disabled={
              refreshingModels ||
              accounts.busy !== null ||
              !accounts.view?.accounts.some((account) => account.channelId === channelId)
            }
            onClick={() => void listModels().catch(() => undefined)}
          >
            {intl.formatMessage({ id: "settings.oauth.refreshModels" })}
          </Button>
          {accounts.error ? (
            <p role="alert" className="text-ui-base text-destructive">
              {intl.formatMessage({ id: "settings.oauth.actionError" })}
            </p>
          ) : null}
          {modelEditor?.(listModels) ?? (
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.oauth.modelsAfterLogin" })}
            </p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
