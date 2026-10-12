import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { ProxyAddressInput } from "./ProxyAddressInput.js";
import { isNetworkProxyUrl } from "@lcode/shared";
import { ProxyLibrary } from "./ProxyLibrary.js";
export function ProxySettingsSection({
  httpProxy = "",
  httpProxyNoProxy = "",
  httpProxyCaCertPath = "",
  onHttpProxyChange,
  onHttpProxyNoProxyChange,
  onHttpProxyCaCertPathChange,
}: {
  httpProxy?: string;
  httpProxyNoProxy?: string;
  httpProxyCaCertPath?: string;
  onHttpProxyChange: (value: string) => Promise<void>;
  onHttpProxyNoProxyChange: (value: string) => Promise<void>;
  onHttpProxyCaCertPathChange: (value: string) => Promise<void>;
}) {
  const { intl } = useLCodeIntl();
  const [localHttpProxy, setLocalHttpProxy] = useState(httpProxy);

  useEffect(() => {
    setLocalHttpProxy(httpProxy);
  }, [httpProxy]);

  const normalizedHttpProxy = localHttpProxy.trim();
  const isHttpProxyDirty =
    normalizedHttpProxy !== httpProxy &&
    (!normalizedHttpProxy || isNetworkProxyUrl(normalizedHttpProxy));

  const handleHttpProxySave = useCallback(async () => {
    await onHttpProxyChange(normalizedHttpProxy);
  }, [normalizedHttpProxy, onHttpProxyChange]);

  const [localHttpProxyNoProxy, setLocalHttpProxyNoProxy] = useState(httpProxyNoProxy);

  useEffect(() => {
    setLocalHttpProxyNoProxy(httpProxyNoProxy);
  }, [httpProxyNoProxy]);

  const normalizedHttpProxyNoProxy = localHttpProxyNoProxy
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean)
    .join(",");
  const isHttpProxyNoProxyDirty = normalizedHttpProxyNoProxy !== httpProxyNoProxy;

  const handleHttpProxyNoProxySave = useCallback(async () => {
    await onHttpProxyNoProxyChange(normalizedHttpProxyNoProxy);
  }, [normalizedHttpProxyNoProxy, onHttpProxyNoProxyChange]);

  const [localHttpProxyCaCertPath, setLocalHttpProxyCaCertPath] = useState(httpProxyCaCertPath);

  useEffect(() => {
    setLocalHttpProxyCaCertPath(httpProxyCaCertPath);
  }, [httpProxyCaCertPath]);

  const normalizedHttpProxyCaCertPath = localHttpProxyCaCertPath.trim();
  const isHttpProxyCaCertPathDirty = normalizedHttpProxyCaCertPath !== httpProxyCaCertPath;

  const handleHttpProxyCaCertPathSave = useCallback(async () => {
    await onHttpProxyCaCertPathChange(normalizedHttpProxyCaCertPath);
  }, [normalizedHttpProxyCaCertPath, onHttpProxyCaCertPathChange]);

  return (
    <div className="space-y-6">
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.httpProxy" })}
          description={intl.formatMessage({ id: "settings.httpProxyDescription" })}
          control={
            <Button
              type="button"
              size="lg"
              disabled={!isHttpProxyDirty}
              onClick={() => void handleHttpProxySave()}
            >
              {intl.formatMessage({ id: "settings.dataBaseDirSave" })}
            </Button>
          }
          detail={
            <ProxyAddressInput
              value={localHttpProxy}
              onChange={setLocalHttpProxy}
              onCommit={() => {
                if (isHttpProxyDirty) void handleHttpProxySave();
              }}
            />
          }
        />
        {/* No Proxy 与 HTTP 代理共同决定同一出口策略，必须贴在代理地址下面。*/}
        <SettingsRow
          label={intl.formatMessage({ id: "settings.httpProxyNoProxy" })}
          description={intl.formatMessage({
            id: "settings.httpProxyNoProxyDescription",
          })}
          control={
            <Button
              type="button"
              size="lg"
              disabled={!isHttpProxyNoProxyDirty}
              onClick={() => void handleHttpProxyNoProxySave()}
            >
              {intl.formatMessage({ id: "settings.dataBaseDirSave" })}
            </Button>
          }
          detail={
            <Input
              size="lg"
              value={localHttpProxyNoProxy}
              placeholder={intl.formatMessage({
                id: "settings.httpProxyNoProxyPlaceholder",
              })}
              onChange={(event) => {
                setLocalHttpProxyNoProxy(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && isHttpProxyNoProxyDirty) {
                  void handleHttpProxyNoProxySave();
                }
              }}
              className="max-w-[520px] font-mono"
            />
          }
        />
        {/* 自定义 CA 属于 HTTP 代理的同一网络出口策略，必须跟代理输入放在同一卡片里。*/}
        <SettingsRow
          label={intl.formatMessage({ id: "settings.httpProxyCaCertPath" })}
          description={intl.formatMessage({
            id: "settings.httpProxyCaCertPathDescription",
          })}
          control={
            <Button
              type="button"
              size="lg"
              disabled={!isHttpProxyCaCertPathDirty}
              onClick={() => void handleHttpProxyCaCertPathSave()}
            >
              {intl.formatMessage({ id: "settings.dataBaseDirSave" })}
            </Button>
          }
          detail={
            <Input
              size="lg"
              value={localHttpProxyCaCertPath}
              placeholder={intl.formatMessage({
                id: "settings.httpProxyCaCertPathPlaceholder",
              })}
              onChange={(event) => {
                setLocalHttpProxyCaCertPath(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && isHttpProxyCaCertPathDirty) {
                  void handleHttpProxyCaCertPathSave();
                }
              }}
              className="max-w-[520px] font-mono"
            />
          }
        />
      </SettingsGroupCard>
      <ProxyLibrary />
    </div>
  );
}
