import { readAuthorizationDiagnostic } from "../authorization-diagnostics.ts";
/** worker 边界只传安全授权事实；cause 不跨线程发送。 */
export function workerFailure(error, scope) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    ...(error?.signIn ? { signIn: error.signIn } : {}),
    ...(scope?.authorization
      ? {
          diagnostic: scope.authorizationDiagnostic?.code
            ? scope.authorizationDiagnostic
            : readAuthorizationDiagnostic(
                error,
                scope.authorizationDiagnostic?.phase ?? "exchange",
              ),
        }
      : {}),
  };
}
