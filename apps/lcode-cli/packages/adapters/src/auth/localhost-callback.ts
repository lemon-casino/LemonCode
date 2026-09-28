import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const LOCALHOST = "127.0.0.1";
const SUCCESS_TEXT = "Authorization successful! You may close this window and return to the CLI.";
const FAILURE_TEXT = "Authorization failed. You may close this window and return to the CLI.";

/** 授权服务器按 RFC 6749 §4.1.2.1 回传 `error` 时使用的稳定错误码。 */
export const MCP_OAUTH_CALLBACK_DENIED_ERROR_CODE = "MCP_OAUTH_CALLBACK_DENIED";

export interface McpOAuthCallbackDeniedError extends Error {
  code: typeof MCP_OAUTH_CALLBACK_DENIED_ERROR_CODE;
  oauthError: string;
  oauthErrorDescription?: string;
}

function createCallbackDeniedError(
  oauthError: string,
  oauthErrorDescription: string | null,
): McpOAuthCallbackDeniedError {
  // 不依赖错误文本做流程判断：调用方按 code/oauthError 结构化字段区分「用户拒绝」与超时。
  const error = new Error(
    `OAuth authorization was rejected by the authorization server: ${oauthError}`,
  ) as McpOAuthCallbackDeniedError;
  error.code = MCP_OAUTH_CALLBACK_DENIED_ERROR_CODE;
  error.oauthError = oauthError;
  if (oauthErrorDescription) error.oauthErrorDescription = oauthErrorDescription;
  return error;
}

export interface LocalhostOAuthCallback {
  code: string;
  url: string;
}

export interface LocalhostOAuthCallbackServer {
  callbackPath: string;
  callbackUrl: string;
  close(): Promise<void>;
  waitForCallback(): Promise<LocalhostOAuthCallback>;
}

export async function createLocalhostOAuthCallbackServer(input: {
  callbackPath: string;
  state: string;
}): Promise<LocalhostOAuthCallbackServer> {
  let resolveCallback: (value: LocalhostOAuthCallback) => void = () => undefined;
  let rejectCallback: (error: Error) => void = () => undefined;
  let settled = false;
  const callbackPromise = new Promise<LocalhostOAuthCallback>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const server = createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", `http://${LOCALHOST}`);
      if (requestUrl.pathname !== input.callbackPath) {
        writeText(response, 404, FAILURE_TEXT);
        return;
      }

      // state 不匹配过去会 reject 本事务的 callback promise。并发授权事务、
      // 浏览器里残留的旧授权 URL 或预取请求都会打到本 listener；一个陌生 state 就能让
      // 随后到达的正确回调再也无法成功。现在只回 400 并继续等待本 state 的回调。
      const state = requestUrl.searchParams.get("state") ?? "";
      if (state !== input.state) {
        writeText(response, 400, FAILURE_TEXT);
        return;
      }

      // state 匹配说明这确实是本事务的授权响应。用户点「拒绝」时授权服务器回
      // error=access_denied，过去要一直等到 caller 超时才失败；现在立即 settle。
      const oauthError = requestUrl.searchParams.get("error");
      if (oauthError) {
        writeText(response, 400, FAILURE_TEXT);
        if (!settled) {
          settled = true;
          rejectCallback(
            createCallbackDeniedError(
              oauthError,
              requestUrl.searchParams.get("error_description"),
            ),
          );
        }
        return;
      }

      const code =
        requestUrl.searchParams.get("authCode") ?? requestUrl.searchParams.get("code") ?? "";
      if (!code) {
        // state 匹配但既无 code 也无 error：授权响应不合法，本事务不可能成功，直接失败，
        // 不消耗剩余授权窗口。
        writeText(response, 400, FAILURE_TEXT);
        if (!settled) {
          settled = true;
          rejectCallback(new Error("OAuth callback is missing an authorization code."));
        }
        return;
      }

      writeText(response, 200, SUCCESS_TEXT);
      if (!settled) {
        settled = true;
        resolveCallback({
          code,
          url: requestUrl.toString(),
        });
      }
    } catch (error) {
      writeText(response, 500, FAILURE_TEXT);
      if (!settled) {
        settled = true;
        rejectCallback(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOCALHOST, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!isAddressInfo(address)) {
    await closeServer(server);
    throw new Error("Unable to resolve localhost callback server address.");
  }

  const callbackUrl = `http://${LOCALHOST}:${address.port}${input.callbackPath}`;
  return {
    callbackPath: input.callbackPath,
    callbackUrl,
    close: async () => {
      await closeServer(server);
    },
    waitForCallback: () => callbackPromise,
  };
}

function writeText(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end(message);
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function isAddressInfo(value: unknown): value is AddressInfo {
  return typeof value === "object" && value !== null && "port" in value;
}
