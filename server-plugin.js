import { existsSync } from "node:fs";
import { resolveCorpus } from "./search/corpus.js";
import { SearchIndex } from "./search/index-store.js";
import { createSettingsStore } from "./search/settings.js";

export const SEARCH_OPERATION = "search";
export const REBUILD_OPERATION = "rebuildIndex";
export const STATUS_OPERATION = "indexStatus";
export const CONFIG_OPERATION = "config";
export const SET_CONFIG_OPERATION = "setConfig";

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
    const settings = createSettingsStore({ dataDirectory: context.dataDirectory, logger: context.logger });
    index.start();
    return {
      peer: {
        async request(request) {
          if (request.operation === SEARCH_OPERATION) return prune(await index.search(request.input, request.signal));
          if (request.operation === REBUILD_OPERATION) return prune(await index.rebuild());
          if (request.operation === STATUS_OPERATION) return prune(await index.indexStatus());
          if (request.operation === CONFIG_OPERATION) return prune(await settings.read());
          if (request.operation === SET_CONFIG_OPERATION) {
            const input = request.input;
            if (input === null || typeof input !== "object" || typeof input.timeFormat !== "string") {
              throw new TypeError("setConfig input must be an object with a string timeFormat");
            }
            return prune(await settings.write({ timeFormat: input.timeFormat }));
          }
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
