import {
  CliOAuthError,
  type CliOAuthClient,
  type CliOAuthInitData,
  type CliOAuthPollData,
  type CliOAuthReadyData,
} from "@lcode/adapters/auth";
import { throwIfAborted, waitWithAbort } from "./auth-login-abort.js";

const MIN_POLL_INTERVAL_MS = 1_000;

export async function pollUntilReady(input: {
  createError: (code: "auth_failed" | "auth_timeout") => Error;
  abortSignal?: AbortSignal;
  initData: CliOAuthInitData;
  now: () => number;
  oauthClient: CliOAuthClient;
  onPollStatus?: (data: CliOAuthPollData) => void | Promise<void>;
  pollToken: string;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
}): Promise<CliOAuthReadyData> {
  const expiresAtMs = input.initData.expires_at * 1_000;
  const deadlineMs = Math.min(input.now() + input.timeoutMs, expiresAtMs);
  const pollIntervalMs = Math.max(MIN_POLL_INTERVAL_MS, input.initData.poll_interval_sec * 1_000);

  while (input.now() < deadlineMs) {
    throwIfAborted(input.abortSignal);
    let data: CliOAuthPollData = { status: "pending" };
    try {
      data = await waitWithAbort(
        input.oauthClient.poll(
          {
            flowId: input.initData.flow_id,
            pollToken: input.pollToken,
          },
          { signal: input.abortSignal },
        ),
        input.abortSignal,
      );
    } catch (error) {
      throwIfAborted(input.abortSignal);
      if (
        error instanceof CliOAuthError &&
        !(error.httpStatus === 408 || error.httpStatus === 429 || (error.httpStatus ?? 0) >= 500)
      )
        throw error;
      // Match App polling: transient network and server failures retry at the server interval.
    }
    throwIfAborted(input.abortSignal);
    if (input.now() >= deadlineMs) break;
    await input.onPollStatus?.(data);

    if (data.status === "ready") {
      return data;
    }
    if (data.status === "failed") {
      throw input.createError("auth_failed");
    }

    await waitWithAbort(
      input.sleep(Math.min(pollIntervalMs, Math.max(0, deadlineMs - input.now()))),
      input.abortSignal,
    );
  }

  throw input.createError("auth_timeout");
}
