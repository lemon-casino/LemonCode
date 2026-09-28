import type { Logger, LoggerFactory } from "@lcode/contracts";

interface RetentionAwareLoggerFactory extends LoggerFactory {
  scheduleLogRetentionCleanup(options?: { logger?: Logger }): unknown;
}

export function scheduleStartupLogRetentionCleanup(
  loggerFactory: LoggerFactory,
  logger: Logger,
): void {
  if (!hasRetentionScheduler(loggerFactory)) return;

  loggerFactory.scheduleLogRetentionCleanup({
    logger: logger.child({
      module: "adapters.logging",
    }),
  });
}

function hasRetentionScheduler(
  loggerFactory: LoggerFactory,
): loggerFactory is RetentionAwareLoggerFactory {
  return (
    "scheduleLogRetentionCleanup" in loggerFactory &&
    typeof loggerFactory.scheduleLogRetentionCleanup === "function"
  );
}
