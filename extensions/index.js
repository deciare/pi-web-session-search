import { companionBackend } from "./companion.js";
import { createSessionTools } from "./tools.js";

/**
 * Agent tools over the session-search backend.
 *
 * The backend is discovered on the hosted pi.events bus at execution time, not
 * here: the plugin may still be starting when a session loads, and discovery
 * before it is ready rejects explicitly.
 */
export default function sessionToolsExtension(pi) {
  const tools = createSessionTools({
    resolveBackend: () => companionBackend(pi.events, "session-search"),
  });
  for (const definition of tools) pi.registerTool(definition);
}
