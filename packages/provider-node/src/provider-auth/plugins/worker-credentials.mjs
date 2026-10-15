/** 私有 worker 凭据通道；账号权限仍由父端原 context 与 CAS 决定。 */
export function createWorkerCredentials({ scopes, check, send, committed }) {
  const reads = new Map();
  let sequence = 0;
  return {
    call(action, grant) {
      check();
      const scope = scopes.getStore();
      if (!scope?.context) throw new Error("Plugin has no account credential context");
      const callId = ++sequence;
      return new Promise((resolve, reject) => {
        reads.set(callId, { resolve, reject, scope, action });
        send({
          kind: "credential",
          action,
          callId,
          operationId: scope.id,
          ...(grant ? (action === "signin" ? { signIn: grant } : { grant }) : {}),
        });
      });
    },
    receive(message) {
      const pending = reads.get(message.callId);
      if (!pending) return;
      reads.delete(message.callId);
      if (pending.scope.controller.signal.aborted && !pending.scope.rotation)
        pending.reject(new DOMException("Operation aborted", "AbortError"));
      else if (message.error)
        pending.reject(Object.assign(new Error(message.error.message), message.error));
      else {
        if (pending.action === "write" && message.value?.refreshCommitted === true)
          committed(pending.scope);
        pending.resolve(message.value);
      }
    },
    close() {
      for (const pending of reads.values())
        pending.reject(new DOMException("Worker closed", "AbortError"));
      reads.clear();
    },
  };
}
