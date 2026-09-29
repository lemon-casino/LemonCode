/* oxlint-disable eslint(max-lines) -- footer 聚合账户、主题、模式和快捷键菜单。 */
import type { Locale, UserInfo } from "@lcode/shared";
import { memo, useCallback, useEffect, useState, type ReactNode } from "react";
import {
  DesktopCommandIds,
  TID_FOOTER_REMOTE_CONTROL_BUTTON,
  TID_LOGIN_MENU_ITEM,
  TID_LOGIN_TRIGGER,
  TID_LOGOUT_BUTTON,
  TID_TASK_SETTINGS_BUTTON,
} from "@lcode/shared";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar.js";
import { cn } from "@/components/lib/utils.js";
import appLogoUrl from "@/assets/app-logo.svg";
import { Button } from "@/components/ui/button.js";
import { ThemeSwatch } from "@/components/ui/ThemeSwatch.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import {
  PencilRuler,
  Globe,
  Loader2,
  LogInIcon,
  LogOut,
  Maximize,
  Palette,
  Settings,
  Smartphone,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { useLCodeStore } from "@/store/StoreProvider.js";
import { normalizeInterfaceMode } from "@/lib/interfaceMode.js";
import { THEME_OPTIONS } from "@/useTheme.js";
import type { Theme } from "@/useTheme.js";
import {
  WorkspaceSidebarFooterPlanBadge,
  WorkspaceSidebarFooterUsageSummaryContent,
  useWorkspaceSidebarFooterUsageSummaryState,
} from "@/WorkspaceSidebarFooterUsageSummary.js";

const DESKTOP_ZOOM_MIN_LEVEL = -3;
const DESKTOP_ZOOM_MAX_LEVEL = 5;

function getSidebarProfileName(user?: UserInfo | null): string {
  const displayName = user?.displayName?.trim();
  if (displayName) {
    return displayName;
  }

  const username = user?.username?.trim();
  if (username) {
    return username;
  }

  return "LCode";
}

function getSidebarProfileBadge(user: UserInfo | null | undefined, fallbackName: string): string {
  if (user) {
    return getSidebarProfileName(user);
  }

  // OAuth 授权登录移除后无账号体系：身份区展示宿主系统用户名，取不到再回退品牌名。
  return fallbackName;
}

function getAvatarFallbackText(user: UserInfo | null | undefined): string {
  const source = user?.displayName?.trim() || user?.username?.trim() || "Z";
  return source[0]?.toUpperCase() ?? "Z";
}

export const WorkspaceSidebarFooter = memo(function WorkspaceSidebarFooterComponent({
  theme,
  localeMenuValue,
  onLocaleChange,
  onThemeChange,
  onSettingsButtonClick,
  remoteControlPanel,
  onUsageClick,
  onLogin,
  onLogout,
  settingsButtonMode = "settings",
  user,
  workspacePath,
  workspaceIdentity,
  isDesktop = false,
  className,
}: {
  theme: Theme;
  localeMenuValue: Locale | "system";
  onLocaleChange: (value: string) => void;
  onThemeChange: (value: string) => void;
  onSettingsButtonClick?: () => void;
  /**
   * 远程控制快捷入口（身份入口与设置按钮之间）的弹框内容，即独立的手机配对块
   * MobileRemoteControlPanel；不传则不渲染入口，平台门禁与 workspace 上下文由调用方决定。
   */
  remoteControlPanel?: ReactNode;
  onUsageClick?: () => void;
  onLogin?: () => void;
  onLogout?: () => void;
  settingsButtonMode?: "settings" | "back";
  user?: UserInfo | null;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  activeTaskId?: string | null;
  isDesktop?: boolean;
  className?: string;
}) {
  const { intl } = useLCodeIntl();
  const platform = usePlatform();
  const interfaceMode = useLCodeStore((state) => state.interfaceMode);
  const setInterfaceMode = useLCodeStore((state) => state.setInterfaceMode);
  const zoomInShortcutLabel = useShortcutCommandLabel("zoomIn");
  const zoomOutShortcutLabel = useShortcutCommandLabel("zoomOut");
  const resetZoomShortcutLabel = useShortcutCommandLabel("resetZoom");
  const isRestoringOAuthSession = useLCodeStore((state) => state.isRestoringOAuthSession);
  // OAuth 授权登录移除后无账号体系：身份区回退展示宿主系统用户名（Desktop 提供）。
  const [systemUsername, setSystemUsername] = useState("");
  useEffect(() => {
    let isCancelled = false;
    void platform
      .getSystemUsername?.()
      .then((name) => {
        if (!isCancelled) {
          setSystemUsername(name.trim());
        }
      })
      .catch(() => {
        // 平台不支持或读取失败时保持空串，身份区回退品牌名。
      });
    return () => {
      isCancelled = true;
    };
  }, [platform]);
  const profileBadge = getSidebarProfileBadge(user, systemUsername || "LCode");
  const avatarFallbackText = getAvatarFallbackText(user);
  const avatarKey = user?.avatarUrl ?? user?.id ?? "guest";
  const showAuthRestoreLoading = !user && isRestoringOAuthSession;
  const showGuestBrandAvatar = !user && !showAuthRestoreLoading;
  const usageSummaryState = useWorkspaceSidebarFooterUsageSummaryState({
    enabled: true,
    workspaceIdentity,
    workspacePath,
  });
  const profileContent = (
    <>
      <Avatar
        key={avatarKey}
        size="default"
        className={showGuestBrandAvatar ? "after:hidden" : undefined}
        data-lcode-brand-avatar={showGuestBrandAvatar ? "transparent" : undefined}
      >
        {user?.avatarUrl ? <AvatarImage src={user.avatarUrl} alt={profileBadge} /> : null}
        <AvatarFallback
          className={cn(
            "text-foreground",
            showGuestBrandAvatar ? "bg-transparent" : "bg-background",
          )}
        >
          {user ? (
            avatarFallbackText
          ) : showAuthRestoreLoading ? (
            <>
              {/* OAuth 启动恢复未落定前，footer 之前会直接显示未登录头像，
                  用户很容易把“还在校验”误判成“已经退出”。
                  这里用 loading 图标明确表达“状态确认中”，等恢复成功或失败后再展示最终状态。 */}
              <Loader2 className="size-4 animate-spin" />
              <span className="sr-only">{intl.formatMessage({ id: "common.loading" })}</span>
            </>
          ) : (
            // 旧实现沿用 AvatarFallback 的主题底色与描边，透明 V12 在浅/深主题上都会出现圆形贴片。
            // 品牌态单独关闭底色与伪元素边框；真实用户头像和 OAuth 恢复态仍保留通用头像样式。
            <span className="flex size-full items-center justify-center overflow-hidden rounded-full">
              <img
                src={appLogoUrl}
                alt="LCode"
                className="size-[86%] select-none"
                draggable={false}
              />
            </span>
          )}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1 overflow-hidden text-left">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-ui-base font-semibold text-foreground">
            {profileBadge}
          </span>
          {user ? <WorkspaceSidebarFooterPlanBadge state={usageSummaryState} /> : null}
        </div>
      </div>
    </>
  );
  const settingsButtonLabel =
    settingsButtonMode === "back"
      ? intl.formatMessage({ id: "workspace.backToWorkspace" })
      : intl.formatMessage({ id: "settings.title" });
  const usageButtonClick = onUsageClick ?? onSettingsButtonClick;
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [desktopZoomLevel, setDesktopZoomLevel] = useState(0);
  const runDesktopZoomCommand = useCallback(
    (command: (typeof DesktopCommandIds)["ZoomIn" | "ZoomOut" | "ResetZoom"]) => {
      void platform.executeDesktopCommand(command);
    },
    [platform],
  );

  useEffect(() => {
    if (!isDesktop) {
      setDesktopZoomLevel(0);
      return;
    }

    let isCancelled = false;
    void platform.getDesktopZoomLevel?.().then((state) => {
      if (!isCancelled && Number.isFinite(state.zoomLevel)) {
        setDesktopZoomLevel(state.zoomLevel);
      }
    });

    const dispose = platform.onDesktopZoomLevelChanged?.((state) => {
      if (Number.isFinite(state.zoomLevel)) {
        setDesktopZoomLevel(state.zoomLevel);
      }
    });

    return () => {
      isCancelled = true;
      dispose?.();
    };
  }, [isDesktop, platform]);

  const canResetDesktopZoom = desktopZoomLevel !== 0;
  const canZoomIn = desktopZoomLevel < DESKTOP_ZOOM_MAX_LEVEL;
  const canZoomOut = desktopZoomLevel > DESKTOP_ZOOM_MIN_LEVEL;

  return (
    // footer 被 Settings 复用，页面专属边距由调用方传入，避免修改共享默认样式。
    <footer className={cn("flex shrink-0 flex-col gap-2.5 px-4 pt-2 pb-4", className)}>
      <div className="flex min-w-0 gap-2">
        <DropdownMenu open={profileMenuOpen} onOpenChange={setProfileMenuOpen}>
          <DropdownMenuTrigger asChild>
            {/* 头像和 Login 之前直接绑定到登录动作，导致用户无法从这里打开偏好设置。
              现在把这一块改成统一的设置菜单入口，登录/退出留在菜单项里，交互职责更清晰。 */}
            <Button
              type="button"
              variant="ghost"
              size={"lg"}
              className="min-w-0 flex-1 justify-start gap-2 overflow-hidden rounded-tl-2xl rounded-bl-2xl border-0 pl-0"
              data-testid={TID_LOGIN_TRIGGER}
              aria-label={profileBadge}
            >
              {/* Button 默认 shrink-0 且带 whitespace-nowrap，超长用户名会把 footer 撑出 sidebar。
                这里让触发按钮和文本列都允许收缩，并只在用户名自身做单行截断。 */}
              {profileContent}
            </Button>
          </DropdownMenuTrigger>
          {/* 菜单内容保持挂载，避免每次点击头像菜单都重建 footer 内部状态。*/}
          <DropdownMenuContent align="start" className="w-max min-w-50" forceMount>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Globe className="size-4" />
                {intl.formatMessage({ id: "settings.locale" })}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48">
                <DropdownMenuRadioGroup value={localeMenuValue} onValueChange={onLocaleChange}>
                  <DropdownMenuRadioItem value="system">
                    {intl.formatMessage({
                      id: "sidebar.settings.systemDefault",
                    })}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="en-US">
                    {intl.formatMessage({
                      id: "sidebar.settings.locale.en-US",
                    })}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="zh-CN">
                    {intl.formatMessage({
                      id: "sidebar.settings.locale.zh-CN",
                    })}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Palette className="size-4" />
                {intl.formatMessage({ id: "settings.themeMode" })}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48">
                {/* 主题清单唯一来源是 useTheme.ts 的 THEME_OPTIONS 注册表；不在组件内维护第二份白名单。 */}
                <DropdownMenuRadioGroup value={theme} onValueChange={onThemeChange}>
                  {THEME_OPTIONS.map((option) => (
                    <DropdownMenuRadioItem key={option.id} value={option.id}>
                      <ThemeSwatch option={option} />
                      {intl.formatMessage({
                        // system 沿用既有的「系统默认」key；静态主题按 id 派生侧栏 key。
                        id:
                          option.id === "system"
                            ? "sidebar.settings.systemDefault"
                            : `sidebar.settings.theme.${option.id}`,
                      })}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <PencilRuler className="size-4" />
                {intl.formatMessage({ id: "settings.interfaceMode" })}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48">
                <DropdownMenuRadioGroup
                  value={interfaceMode}
                  onValueChange={(value) => setInterfaceMode(normalizeInterfaceMode(value))}
                >
                  <DropdownMenuRadioItem value="coding">
                    {intl.formatMessage({ id: "settings.interfaceMode.coding" })}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="office">
                    {intl.formatMessage({ id: "settings.interfaceMode.office" })}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {/* 快捷键设置：缩放子菜单 label 读生效表，设置页改绑后即时跟随 */}
            {/* 收口重复缩放子菜单时误留了语言之后的那份，导致菜单顺序变成
                语言→缩放→主题；账户菜单分组顺序固定为 语言→主题→界面模式→缩放→用量→登录/登出，
                这里把唯一一份（读生效表）挪回用量摘要之前，不要再补第二份缩放子菜单。 */}
            {isDesktop ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <ZoomIn className="size-4" />
                  {intl.formatMessage({ id: "sidebar.settings.interfaceZoom" })}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-50">
                  <DropdownMenuItem
                    disabled={!canZoomIn}
                    onSelect={() => runDesktopZoomCommand(DesktopCommandIds.ZoomIn)}
                  >
                    <ZoomIn className="size-4" />
                    {intl.formatMessage({ id: "titleBar.menu.view.zoomIn" })}
                    <DropdownMenuShortcut>{zoomInShortcutLabel}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!canZoomOut}
                    onSelect={() => runDesktopZoomCommand(DesktopCommandIds.ZoomOut)}
                  >
                    <ZoomOut className="size-4" />
                    {intl.formatMessage({ id: "titleBar.menu.view.zoomOut" })}
                    <DropdownMenuShortcut>{zoomOutShortcutLabel}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!canResetDesktopZoom}
                    onSelect={() => runDesktopZoomCommand(DesktopCommandIds.ResetZoom)}
                  >
                    <Maximize className="size-4" />
                    {intl.formatMessage({ id: "titleBar.menu.view.actualSize" })}
                    <DropdownMenuShortcut>{resetZoomShortcutLabel}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : null}
            <WorkspaceSidebarFooterUsageSummaryContent
              state={usageSummaryState}
              onUsageClick={usageButtonClick}
            />
            {onLogin && !user ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onLogin} data-testid={TID_LOGIN_MENU_ITEM}>
                  <LogInIcon className="size-4" />
                  {intl.formatMessage({ id: "app.login" })}
                </DropdownMenuItem>
              </>
            ) : null}
            {onLogout ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onLogout} data-testid={TID_LOGOUT_BUTTON}>
                  <LogOut className="size-4" />
                  {intl.formatMessage({ id: "app.logout" })}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex shrink-0 items-center gap-1.5">
          {remoteControlPanel ? (
            <Popover>
              <ControlHintTooltip
                title={intl.formatMessage({ id: "settings.remoteControl.title" })}
              >
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-lg"
                    data-testid={TID_FOOTER_REMOTE_CONTROL_BUTTON}
                    aria-label={intl.formatMessage({ id: "settings.remoteControl.title" })}
                  >
                    <Smartphone className="size-4" />
                  </Button>
                </PopoverTrigger>
              </ControlHintTooltip>
              {/* footer 贴屏幕底边：向上弹出；宽度收到视口内，224px 二维码可完整容纳。 */}
              <PopoverContent side="top" align="start" className="w-[min(92vw,400px)] p-0">
                {remoteControlPanel}
              </PopoverContent>
            </Popover>
          ) : null}
          <ControlHintTooltip title={settingsButtonLabel}>
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              data-testid={TID_TASK_SETTINGS_BUTTON}
              aria-label={settingsButtonLabel}
              disabled={!onSettingsButtonClick}
              onClick={onSettingsButtonClick}
            >
              <Settings className="size-4" />
            </Button>
          </ControlHintTooltip>
        </div>
      </div>
    </footer>
  );
});
