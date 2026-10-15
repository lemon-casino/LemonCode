import { isPluginRefreshRequest } from "./refresh-policy.mjs";

const ROTATION_BUDGET_MS = 30_000;

export function createWorkerRefresh({ channel, scopes, credential, send }) {
  return {
    async before(input, init) {
      const scope = scopes.getStore();
      if (!scope || !isPluginRefreshRequest(channel, input, init)) {
        scope?.controller.signal.throwIfAborted();
        return undefined;
      }
      if (scope.rotation) return scope.rotation.signal;
      scope.rotationBeginRequested = true;
      const permit = await credential("refresh-begin");
      scope.controller.signal.throwIfAborted();
      if (!permit?.allowed) return undefined;
      const controller = new AbortController();
      scope.rotationAdmitted = true;
      scope.rotation = {
        controller,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(ROTATION_BUDGET_MS)]),
      };
      return scope.rotation.signal;
    },
    committed(scope) {
      scope.rotation?.controller.abort();
      scope.rotation = undefined;
    },
    end(scope) {
      scope.rotation?.controller.abort();
      scope.rotation = undefined;
      if (scope.rotationBeginRequested)
        send({
          kind: "refresh-end",
          operationId: scope.id,
          admitted: scope.rotationAdmitted === true,
        });
    },
  };
}
