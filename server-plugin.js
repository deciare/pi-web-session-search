import { existsSync } from "node:fs";
import { resolveCorpus } from "./search/corpus.js";
import { SearchIndex } from "./search/index-store.js";

export const SEARCH_OPERATION = "search";
export const REBUILD_OPERATION = "rebuildIndex";
export const STATUS_OPERATION = "indexStatus";

const plugin = {
  apiVersion: 5,
  name: "Session search",
  activate(context) {
    const corpus = resolveCorpus();
    const index = new SearchIndex({
      dataDirectory: context.dataDirectory,
      corpus,
      logger: context.logger,
      notices: context.notices,
    });
    context.lifetimeSignal.addEventListener("abort", () => index.dispose(), { once: true });
    if (!existsSync(corpus.sessionDir)) {
      try {
        context.notices?.record?.({
          severity: "warning",
          message: `Session search found no transcript directory at ${corpus.sessionDir}; check PI_CODING_AGENT_DIR.`,
        });
      } catch {
        // A notice must never fail activation.
      }
    }
    index.start();
    return {
      peer: {
        async request(request) {
          if (request.operation === SEARCH_OPERATION) return prune(await index.search(request.input, request.signal));
          if (request.operation === REBUILD_OPERATION) return prune(await index.rebuild());
          if (request.operation === STATUS_OPERATION) return prune(await index.indexStatus());
          throw new Error(`Unsupported session search operation: ${request.operation}`);
        },
      },
    };
  },
};

export default plugin;

/**
 * The peer transport carries JsonValue, so an absent optional field is dropped
 * rather than serialised as `undefined`.
 */
function prune(value) {
  if (Array.isArray(value)) return value.map(prune);
  if (value === null || typeof value !== "object") return value;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    result[key] = prune(entry);
  }
  return result;
}
