import { AsyncLocalStorage } from "node:async_hooks";
import type { ProviderAuthorizationDiagnostic } from "@lcode/shared";
import type { AuthChallenge } from "./driver.js";
import { authorizationRequestPhase } from "./authorization-phase.js";
import { readAuthorizationDiagnostic } from "./authorization-diagnostics.js";
type Observer = (fact: ProviderAuthorizationDiagnostic) => void;
interface Scope {
  observe?: Observer;
  phase: ProviderAuthorizationDiagnostic["phase"];
  failure?: ProviderAuthorizationDiagnostic;
}
/** 工厂的观测边界只传递事实，不拥有授权终态、凭据或重试。 */
export class AuthAuthorizationTracker {
  private readonly scope = new AsyncLocalStorage<Scope>();
  private report(scope: Scope, phase: Scope["phase"]): void {
    scope.phase = phase;
    scope.observe?.({ phase, credentialsSaved: false });
  }
  private failure(error: unknown, scope: Scope): Error {
    const value =
      error instanceof Error ? error : new Error("Authorization failed", { cause: error });
    return Object.assign(value, {
      diagnostic: scope.failure ?? readAuthorizationDiagnostic(error, scope.phase),
    });
  }
  fetch(fetcher: typeof fetch): typeof fetch {
    return async (input, init) => {
      const scope = this.scope.getStore();
      if (scope) scope.failure = undefined;
      if (scope)
        this.report(
          scope,
          authorizationRequestPhase(input instanceof Request ? input.url : String(input)) ??
            scope.phase,
        );
      try {
        const response = await fetcher(input, init);
        if (scope && !response.ok) {
          scope.failure = readAuthorizationDiagnostic({ status: response.status }, scope.phase);
          scope.observe?.(scope.failure);
        }
        return response;
      } catch (error) {
        throw scope ? this.failure(error, scope) : error;
      }
    };
  }
  async authorize(run: () => Promise<AuthChallenge>, observe?: Observer): Promise<AuthChallenge> {
    const scope: Scope = { observe, phase: "preparing" };
    return this.scope.run(scope, async () => {
      try {
        this.report(scope, "preparing");
        const challenge = await run();
        this.report(scope, "waiting");
        const complete = async <T>(operation: () => Promise<T>) =>
          this.scope.run(scope, async () => {
            try {
              this.report(scope, "exchange");
              return await operation();
            } catch (error) {
              throw this.failure(error, scope);
            }
          });
        return {
          ...challenge,
          complete: (code) => complete(() => challenge.complete(code)),
          ...(challenge.completeMany
            ? { completeMany: () => complete(() => challenge.completeMany!()) }
            : {}),
        };
      } catch (error) {
        throw this.failure(error, scope);
      }
    });
  }
}
