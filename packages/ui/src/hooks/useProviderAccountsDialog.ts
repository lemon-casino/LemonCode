import { useCallback, useState } from "react";

/** 弹窗只保存展示渠道与还焦目标；账号和授权事实仍由 Host 与账号 hook 管理。 */
export function useProviderAccountsDialog() {
  const [selection, setSelection] = useState<{
    channelId: string;
    returnFocus: HTMLElement | null;
  } | null>(null);
  const openChannel = useCallback((channelId: string) => {
    setSelection({
      channelId,
      returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    });
  }, []);
  const close = useCallback(() => setSelection(null), []);
  return { selection, openChannel, close };
}
