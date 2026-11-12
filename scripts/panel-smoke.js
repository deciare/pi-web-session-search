/**
 * Render the panel against a fake backend in a DOM, without a browser.
 *
 * The browser half has no unit tests: it is one custom element and a
 * contribution. This script exercises the parts that can silently break — the
 * module graph, localization registration, the peer request, result rendering
 * and the navigation call — by borrowing the pi-web checkout's happy-dom and
 * lit.
 *
 *   PI_WEB_ROOT=/data/home/src/pi-web node scripts/panel-smoke.js
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.PI_WEB_ROOT ?? "/data/home/src/pi-web";
const load = (path) => import(pathToFileURL(join(root, path)).href);

const { Window } = await load("node_modules/happy-dom/lib/index.js");
const window = new Window({ url: "http://localhost/" });
globalThis.window = window;
for (const key of Object.getOwnPropertyNames(window)) {
  if (key in globalThis) continue;
  try {
    globalThis[key] = window[key];
  } catch {
    // Accessors that need a receiver.
  }
}
globalThis.document = window.document;
globalThis.customElements = window.customElements;
globalThis.CSSStyleSheet = window.CSSStyleSheet;
globalThis.Document = window.Document;

const { html, render } = await load("node_modules/lit/index.js");
const { default: plugin } = await import(new URL("../browser/pi-web-plugin.js", import.meta.url).href);
const { CONFIG_OPERATION, OPERATION_NAME, REBUILD_INDEX_OPERATION, SEARCH_OPERATION, SET_CONFIG_OPERATION } = await import(new URL("../browser/operations.js", import.meta.url).href);

const localization = {
  message: (text, description) => ({ message: text, description }),
  registerMessages: (namespace, definitions) => ({
    t(key, values) {
      const definition = definitions[key];
      if (definition === undefined) throw new Error(`missing message ${namespace}.${key}`);
      return values === undefined
        ? definition.message
        : definition.message.replace(/\{(\w+)\}/gu, (_match, name) => String(values[name] ?? ""));
    },
  }),
  date: (value) => `date(${value.toISOString().slice(0, 10)})`,
  relativeTime: (value, unit) => `${String(value)} ${unit}s ago`,
};

const activation = plugin.activate({
  apiVersion: 5,
  pluginId: "session-search",
  runtimePluginId: "session-search",
  html,
  svg: html,
  localization,
  signal: new AbortController().signal,
  lifetimeSignal: new AbortController().signal,
});
const [panel] = activation.contributions.applicationPanels;
assert(panel !== undefined, "the plugin contributes a panel");
assert(panel.title === "Search", `panel title is localized (${panel.title})`);

const requests = [];
let savedFormat;
let savedArchived;
const response = (overrides) => ({
  hits: [
    { sessionId: "s1", entryId: "e9", role: "user", snippet: "…rollback plan…", matchStart: 4, matchLength: 8,
      timestamp: "2026-11-10T12:34:56.000Z",
      session: { cwd: "/data/home/src", name: "A session", modified: "2026-11-11T00:00:00.000Z", archived: false } },
    { sessionId: "s1", entryId: "e10", role: "tool", snippet: "Which way on the scheduler?", matchStart: 0, matchLength: 6,
      timestamp: "2026-11-09T01:02:03.000Z",
      session: { cwd: "/data/home/src", name: "A session", modified: "2026-11-11T00:00:00.000Z", archived: false } },
  ],
  total: 2, truncated: false, source: "index", indexing: { done: 3, total: 4, rebuilding: false }, ms: 4,
  ...overrides,
});
const context = {
  machine: { id: "local", name: "Local", kind: "local" },
  backend: {
    machineId: "local",
    forScope: () => ({
      request: async (operation, input) => {
        // The host rejects an operation name before the plugin sees it; mirror
        // that here so a capitalised name fails this smoke test too.
        if (operation.length > 128 || !OPERATION_NAME.test(operation)) {
          throw new Error(`Plugin backend operation must match ${String(OPERATION_NAME)}: ${operation}`);
        }
        requests.push({ operation, input });
        if (operation === SEARCH_OPERATION) return response();
        if (operation === REBUILD_INDEX_OPERATION) return { started: true };
        if (operation === CONFIG_OPERATION) return { timeFormat: savedFormat ?? "relative", includeArchived: savedArchived ?? true };
        if (operation === SET_CONFIG_OPERATION) {
          if (input.timeFormat !== undefined) savedFormat = input.timeFormat;
          if (input.includeArchived !== undefined) savedArchived = input.includeArchived;
          return { timeFormat: savedFormat ?? "relative", includeArchived: savedArchived ?? true };
        }
        return {};
      },
    }),
  },
  catalog: {
    projects: { list: async () => [{ id: "p1", name: "Project", path: "/data/home" }] },
    workspaces: { list: async () => [{ id: "w1", projectId: "p1", path: "/data/home/src", label: "main", isMain: true }] },
  },
  navigated: [],
  navigate: async (destination) => { context.navigated.push(destination); },
};

const container = document.createElement("div");
document.body.append(container);
render(panel.render(context), container);

const element = container.querySelector("session-search-panel");
assert(element?.shadowRoot !== null, "the panel element mounted with a shadow root");
const input = element.shadowRoot.querySelector("input");
input.value = "rollback";
input.dispatchEvent(new window.Event("input"));
await new Promise((resolve) => setTimeout(resolve, 350));

assert(requests.some((request) => request.operation === SEARCH_OPERATION), "the query reached the peer");
const rows = [...element.shadowRoot.querySelectorAll("[data-hit]")];
assert(rows.length === 2, `two rows rendered (${String(rows.length)})`);
const groups = [...element.shadowRoot.querySelectorAll(".session-group")];
assert(groups.length === 1, `one block per session (${String(groups.length)})`);
assert(groups[0].querySelector(".session-name")?.id === groups[0].getAttribute("aria-labelledby"), "the block is labelled by its header");
assert(groups[0].querySelectorAll("[data-hit]").length === 2, "the hits are children of the block");
assert(element.shadowRoot.querySelector("mark")?.textContent === "rollback", "the match is marked");
assert(rows[1]?.textContent?.startsWith("question"), "the role label reads as a question");
assert(element.shadowRoot.querySelector(".meta")?.textContent?.includes("4 ms") === true, "the source and timing are shown");

rows[0].click();
await new Promise((resolve) => setTimeout(resolve, 20));
const destination = context.navigated[0];
assert(destination?.sessionId === "s1" && destination?.messageEntryId === "e9", "a hit navigates to its entry");
assert(destination?.view === "chat", "a hit opens the conversation");
assert(destination?.projectId === "p1" && destination?.workspaceId === "w1", "the cwd is resolved to a workspace");

// ---- timestamp format ------------------------------------------------------

const formatButton = element.shadowRoot.querySelector(".time-format");
assert(formatButton?.textContent === "Time: relative", `the footer names the default (${formatButton?.textContent})`);
formatButton.click();
const dialog = element.shadowRoot.querySelector(".time-dialog");
assert(dialog !== null && (dialog.hasAttribute("open") || dialog.open === true), "the format dialog opened");
const formatInput = dialog.querySelector("input.format");
formatInput.value = "%Y-%m-%d %H:%M:%S";
dialog.querySelector(".actions .primary").click();
await new Promise((resolve) => setTimeout(resolve, 20));
assert(savedFormat === "%Y-%m-%d %H:%M:%S", `the format was written through the peer (${String(savedFormat)})`);
assert(dialog.hasAttribute("open") === false, "the dialog closed on save");

const sessionMeta = element.shadowRoot.querySelector(".session-meta")?.textContent ?? "";
assert(/2026-11-\d\d/.test(sessionMeta), `the session header shows an absolute time (${sessionMeta})`);
assert(!sessionMeta.includes("ago"), "the relative phrase is gone");
assert(formatButton.textContent === "Time: %Y-%m-%d %H:%M:%S", `the footer names the pattern (${formatButton.textContent})`);
assert(requests.some((request) => request.operation === CONFIG_OPERATION), "the panel read the shared configuration");
assert(requests.find((request) => request.operation === SEARCH_OPERATION)?.input.includeArchived === true, "archived sessions are included by default");

// ---- archived filter --------------------------------------------------------

const archivedBox = element.shadowRoot.querySelector(".archived input");
assert(archivedBox?.checked === true, "the archived checkbox reflects the setting");
archivedBox.checked = false;
archivedBox.dispatchEvent(new window.Event("change"));
await new Promise((resolve) => setTimeout(resolve, 30));
assert(savedArchived === false, `the checkbox writes through the peer (${String(savedArchived)})`);
const lastSearch = [...requests].reverse().find((request) => request.operation === SEARCH_OPERATION);
assert(lastSearch?.input.includeArchived === false, "the next search excludes archived sessions");
const rowTitle = element.shadowRoot.querySelector("[data-hit]")?.title ?? "";
const metaTitle = element.shadowRoot.querySelector(".session-meta")?.title ?? "";
assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(rowTitle), `a row's tooltip is a full timestamp (${rowTitle})`);
assert(rowTitle !== metaTitle, "a row's tooltip is the message time, not the session's");
assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(metaTitle), `the header still names the session time (${metaTitle})`);

console.log("panel smoke: ok");

function assert(condition, message) {
  if (!condition) throw new Error(`panel smoke failed: ${message}`);
}
