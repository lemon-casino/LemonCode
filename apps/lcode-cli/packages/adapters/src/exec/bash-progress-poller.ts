type ProgressSubscriber = {
  reading: boolean;
  poll: (isActive: () => boolean) => Promise<void>;
};
type PollingGroup = {
  subscribers: Set<ProgressSubscriber>;
  timer: NodeJS.Timeout;
};

// 按周期共享：产品默认只有一个 1 秒轮询器，内部自定义周期不改变其他任务的频率。
const pollingGroups = new Map<number, PollingGroup>();

export function subscribeBashOutputProgress(
  intervalMs: number,
  poll: ProgressSubscriber["poll"],
): () => void {
  let group = pollingGroups.get(intervalMs);
  if (!group) {
    const subscribers = new Set<ProgressSubscriber>();
    const timer = setInterval(() => {
      for (const subscriber of subscribers) {
        if (subscriber.reading) continue;
        subscriber.reading = true;
        const isActive = () => subscribers.has(subscriber);
        void Promise.resolve()
          .then(() => {
            if (isActive()) return subscriber.poll(isActive);
          })
          // 预览是尽力读取；单个文件或回调失败不能停止其他 Bash 的共享进度。
          .catch(() => undefined)
          .finally(() => {
            subscriber.reading = false;
          });
      }
    }, intervalMs);
    timer.unref();
    group = { subscribers, timer };
    pollingGroups.set(intervalMs, group);
  }
  const subscriber = { reading: false, poll };
  const { subscribers, timer } = group;
  subscribers.add(subscriber);
  return () => {
    // 旧订阅重复清理时不能删除同周期的新轮询器。
    if (!subscribers.delete(subscriber) || subscribers.size > 0) return;
    clearInterval(timer);
    pollingGroups.delete(intervalMs);
  };
}
