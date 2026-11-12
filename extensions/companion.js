/**
 * Discover this package's paired v5 backend on a hosted PI WEB event bus.
 *
 * This mirrors `createCompanionBackend` from pi-web's `server-plugin-api`, which
 * the extension cannot import: pi-web's extension loader resolves its own
 * packages and `typebox`, not `@jmfederico/pi-web`, and this package is
 * installed outside pi-web's module tree. The protocol is one channel and one
 * callback; keep it in step with `src/server-plugin-api.ts` upstream.
 */
export function companionBackend(events, pluginId) {
  let backend;
  let failure;
  events.emit("pi-web:companion-backend:discover", {
    pluginId,
    accept: (discover) => {
      try {
        backend = discover();
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      }
    },
  });
  if (failure !== undefined) throw failure;
  if (backend === undefined) throw new Error("Companion backend discovery requires a hosted PI WEB event bus");
  return backend;
}

/** One request against the machine-scoped peer, with the caller's abort signal. */
export async function requestBackend(backend, operation, input, signal) {
  const peer = backend.forScope({ kind: "machine" });
  if (peer.request === undefined) throw new Error(`Session search backend does not support ${operation} requests`);
  return await peer.request(operation, input, signal === undefined ? {} : { signal });
}
