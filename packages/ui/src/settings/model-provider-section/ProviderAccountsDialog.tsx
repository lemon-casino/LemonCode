import { useRef, type ReactNode } from "react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useProviderAccounts } from "@/hooks/useProviderAccounts.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { ProviderAccountsContent } from "./ProviderAccountsContent.js";

export function ProviderAccountsDialog({
  channelId,
  returnFocus,
  onClose,
  modelEditor,
}: {
  channelId: string;
  returnFocus: HTMLElement | null;
  onClose: () => void;
  modelEditor?: (listModels: () => Promise<readonly string[]>) => ReactNode;
}) {
  const accounts = useProviderAccounts();
  const { intl } = useLCodeIntl();
  const closing = useRef(false);
  const channel = accounts.view?.channels.find((item) => item.id === channelId);
  const close = async () => {
    if (closing.current) return;
    closing.current = true;
    try {
      // Radix 的关闭请求不能先卸载表单；取消失败时保留原 attempt 和可重试反馈。
      if (
        (accounts.authorization?.status !== "pending" && accounts.busy !== "authorize") ||
        (await accounts.cancel())
      )
        onClose();
    } finally {
      closing.current = false;
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <DialogContent
        className="flex w-[42rem] flex-col overflow-hidden"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
        }}
      >
        <DialogHeader className="pr-9">
          <DialogTitle>{channel?.name ?? channelId}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "settings.oauth.manageDescription" })}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4 pr-1">
          <ProviderAccountsContent
            channelId={channelId}
            accounts={accounts}
            modelEditor={modelEditor}
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
