/**
 * 草稿态空态问候：时间问候语 + LCode Logo。
 * 自旧版 ChatView/ChatViewEmptyState.tsx 恢复（该组件随旧 ChatView 删除，
 * i18n key `chat.empty.greeting.*` 一直保留）；边界时刻自动换档逻辑保真。
 * Desktop 与手机 Web 共用全局 UI 字号及自然换行。
 */
import { useEffect, useState } from "react";
import appLogoUrl from "@/assets/app-logo.svg";
import { cn } from "@/components/lib/utils.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";

const GREETING_BOUNDARY_HOURS = [5, 9, 12, 14, 18, 23] as const;

type ChatEmptyGreetingMessageId =
  | "chat.empty.greeting.morningEarly"
  | "chat.empty.greeting.morning"
  | "chat.empty.greeting.noon"
  | "chat.empty.greeting.afternoon"
  | "chat.empty.greeting.evening"
  | "chat.empty.greeting.lateNight";

function getChatEmptyGreetingMessageId(date: Date = new Date()): ChatEmptyGreetingMessageId {
  const hour = date.getHours();

  if (hour >= 5 && hour < 9) return "chat.empty.greeting.morningEarly";
  if (hour >= 9 && hour < 12) return "chat.empty.greeting.morning";
  if (hour >= 12 && hour < 14) return "chat.empty.greeting.noon";
  if (hour >= 14 && hour < 18) return "chat.empty.greeting.afternoon";
  if (hour >= 18 && hour < 23) return "chat.empty.greeting.evening";

  return "chat.empty.greeting.lateNight";
}

function getNextChatEmptyGreetingDelayMs(date: Date = new Date()) {
  const candidates = GREETING_BOUNDARY_HOURS.map((hour) => {
    const boundary = new Date(date);
    boundary.setHours(hour, 0, 0, 0);
    return boundary;
  });
  const tomorrowFirstBoundary = new Date(date);
  tomorrowFirstBoundary.setDate(tomorrowFirstBoundary.getDate() + 1);
  tomorrowFirstBoundary.setHours(GREETING_BOUNDARY_HOURS[0], 0, 0, 0);

  const nextBoundary =
    candidates.find((candidate) => candidate.getTime() > date.getTime()) ?? tomorrowFirstBoundary;

  return Math.max(1, nextBoundary.getTime() - date.getTime());
}

export function ConversationDraftEmptyState({ className }: { className?: string }) {
  const { intl } = useLCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const [greetingDate, setGreetingDate] = useState(() => new Date());
  const greeting = intl.formatMessage({
    id: isOfficeMode ? "chat.empty.greeting.office" : getChatEmptyGreetingMessageId(greetingDate),
  });

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setGreetingDate(new Date());
    }, getNextChatEmptyGreetingDelayMs(greetingDate));

    return () => window.clearTimeout(timeout);
  }, [greetingDate]);

  // 大渐隐水印仍需占位；原绝对定位不占高度，会让标题落入 composer 的遮罩区域。
  // 方形图像的透明尾部曾留下很大视觉空隙；只裁切装饰图形，标题仍独立自然换行。
  return (
    <div
      className={cn(
        "flex w-full max-w-2xl shrink-0 flex-col items-center gap-2 text-foreground",
        className,
      )}
    >
      <div
        data-v4-draft-logo-frame="true"
        aria-hidden="true"
        className="aspect-[3/2] w-[min(60vw,20rem,32dvh)] max-w-full shrink-0 overflow-hidden"
      >
        <img
          aria-hidden="true"
          data-v4-draft-logo="v12"
          src={appLogoUrl}
          alt=""
          draggable={false}
          className={cn(
            "aspect-square h-auto w-full object-contain opacity-[0.24] dark:opacity-[0.32]",
            "[-webkit-mask-image:linear-gradient(to_bottom,black_0%,transparent_78%,transparent_100%)]",
            "[-webkit-mask-repeat:no-repeat] [-webkit-mask-size:100%_100%]",
            "[mask-image:linear-gradient(to_bottom,black_0%,transparent_78%,transparent_100%)]",
            "[mask-repeat:no-repeat] [mask-size:100%_100%]",
          )}
        />
      </div>
      <p
        data-v4-draft-greeting="true"
        className="w-full px-4 text-center text-ui-greeting leading-relaxed font-medium text-foreground [overflow-wrap:anywhere]"
      >
        {greeting}
      </p>
    </div>
  );
}
