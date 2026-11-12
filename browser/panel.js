import {
  CONFIG_OPERATION,
  REBUILD_INDEX_OPERATION,
  SEARCH_OPERATION,
  SET_CONFIG_OPERATION,
} from "./operations.js";
import { DEFAULT_ABSOLUTE_PATTERN, RELATIVE, formatTimestamp, normalizeTimeFormat } from "./timeFormat.js";

export const PANEL_TAG = "session-search-panel";
const DEBOUNCE_MS = 200;
const REBUILD_POLL_MS = 1500;

const rememberedQueries = new Map();

/** Install the panel element once per page. */
export function defineSessionSearchPanel() {
  if (customElements.get(PANEL_TAG) !== undefined) return;
  customElements.define(PANEL_TAG, SessionSearchPanel);
}

class SessionSearchPanel extends HTMLElement {
  #context;
  #localization;
  #messages;
  #query = "";
  #input;
  #status;
  #meta;
  #rebuildButton;
  #formatButton;
  #archivedBox;
  #archivedLabel;
  #includeArchived = true;
  #formatDialog;
  #formatInput;
  #formatHeading;
  #formatLabel;
  #formatHint;
  #formatCancel;
  #formatSave;
  #formatError;
  #timeFormat = RELATIVE;
  #configRequested = false;
  #results;
  #response;
  #error;
  #loading = false;
  #cursor;
  #controller;
  #debounce;
  #poll;
  #seq = 0;
  #machineId;

  constructor() {
    super();
    this.#build();
  }

  set context(context) {
    this.#context = context;
    const machineId = context?.machine?.id ?? "local";
    if (this.#machineId !== undefined && this.#machineId !== machineId) {
      this.#query = "";
      this.#results?.replaceChildren();
      this.#response = undefined;
      this.#cursor = undefined;
    }
    this.#machineId = machineId;
    void this.#loadConfig();
    if (this.#query === "" && rememberedQueries.has(machineId)) {
      this.#query = rememberedQueries.get(machineId);
      this.#input.value = this.#query;
      this.#schedule(0);
    }
    this.#renderStatus();
  }

  set messages(messages) {
    this.#messages = messages;
    this.#renderStatus();
  }

  set localization(localization) {
    this.#localization = localization;
    this.#renderStatus();
  }

  connectedCallback() {
    void this.#loadConfig();
    this.#renderStatus();
    if (!this.#query && rememberedQueries.has(this.#machineId ?? "local")) {
      this.#query = rememberedQueries.get(this.#machineId ?? "local");
      this.#input.value = this.#query;
      this.#schedule(0);
    }
  }

  disconnectedCallback() {
    if (this.#debounce !== undefined) clearTimeout(this.#debounce);
    if (this.#poll !== undefined) clearTimeout(this.#poll);
    this.#controller?.abort();
    this.#controller = undefined;
  }

  // ------------------------------------------------------------------ search

  #schedule(delayMs = DEBOUNCE_MS) {
    if (this.#debounce !== undefined) clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => {
      this.#debounce = undefined;
      void this.#search();
    }, delayMs);
  }

  async #search() {
    const query = this.#query.trim();
    const backend = this.#context?.backend?.forScope?.({ kind: "machine" });
    if (query === "") {
      this.#results.replaceChildren();
      this.#response = undefined;
      this.#error = undefined;
      this.#renderStatus();
      return;
    }
    if (backend === undefined || typeof backend.request !== "function") {
      this.#error = this.#text("unavailable");
      this.#renderStatus();
      return;
    }
    this.#controller?.abort();
    const controller = new AbortController();
    this.#controller = controller;
    const seq = ++this.#seq;
    this.#loading = true;
    this.#renderStatus();
    try {
      const response = await backend.request(SEARCH_OPERATION, {
        query,
        limit: 50,
        includeArchived: this.#includeArchived,
      }, { signal: controller.signal });
      if (seq !== this.#seq) return;
      this.#response = response;
      this.#error = undefined;
      this.#cursor = response.nextCursor;
      this.#renderResults();
    } catch (error) {
      if (seq !== this.#seq || controller.signal.aborted) return;
      this.#error = this.#text("failed", { message: messageOf(error) });
      this.#response = undefined;
      this.#renderResults();
    } finally {
      if (seq === this.#seq) {
        this.#loading = false;
        this.#renderStatus();
        this.#scheduleRebuildPoll();
      }
    }
  }

  async #loadMore() {
    if (this.#cursor === undefined) return;
    const backend = this.#context?.backend?.forScope?.({ kind: "machine" });
    if (backend === undefined) return;
    const seq = this.#seq;
    try {
      const response = await backend.request(SEARCH_OPERATION, {
        query: this.#query.trim(),
        limit: 50,
        includeArchived: this.#includeArchived,
        cursor: this.#cursor,
      });
      if (seq !== this.#seq) return;
      this.#response = {
        ...response,
        hits: [...(this.#response?.hits ?? []), ...(response.hits ?? [])],
      };
      this.#cursor = response.nextCursor;
      this.#renderResults();
      this.#renderStatus();
    } catch (error) {
      this.#error = this.#text("failed", { message: messageOf(error) });
      this.#renderStatus();
    }
  }

  /** The shared format lives in the plugin's settings.json; read it once per connection. */
  async #loadConfig() {
    if (this.#configRequested) return;
    const backend = this.#backend();
    if (backend === undefined) return;
    this.#configRequested = true;
    try {
      const config = await backend.request(CONFIG_OPERATION, {});
      this.#timeFormat = normalizeTimeFormat(config?.timeFormat);
      this.#includeArchived = typeof config?.includeArchived === "boolean" ? config.includeArchived : true;
      this.#renderStatus();
      this.#renderResults();
    } catch {
      // Keep the default; a config read must never stop a search.
      this.#configRequested = false;
    }
  }

  #backend() {
    const backend = this.#context?.backend?.forScope?.({ kind: "machine" });
    return backend === undefined || typeof backend.request !== "function" ? undefined : backend;
  }

  #openTimeFormat() {
    const dialog = this.#formatDialog;
    if (dialog === undefined) return;
    this.#formatInput.value = this.#timeFormat;
    this.#formatError.textContent = "";
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    this.#formatInput.focus();
    this.#formatInput.select();
  }

  #closeTimeFormat() {
    const dialog = this.#formatDialog;
    if (dialog === undefined) return;
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }

  async #saveTimeFormat(value) {
    if (this.#backend() === undefined) {
      this.#formatError.textContent = this.#text("unavailable");
      return;
    }
    this.#formatSave.disabled = true;
    try {
      await this.#saveConfig({ timeFormat: normalizeTimeFormat(value) });
      this.#formatError.textContent = "";
      this.#renderResults();
      this.#closeTimeFormat();
    } catch (error) {
      this.#formatError.textContent = this.#text("timeFormatSaveFailed", { message: messageOf(error) });
    } finally {
      this.#formatSave.disabled = false;
    }
  }

  async #saveArchived(checked) {
    this.#archivedBox.disabled = true;
    try {
      await this.#saveConfig({ includeArchived: checked });
      this.#error = undefined;
      if (this.#query.trim() === "") this.#renderStatus();
      else await this.#search();
    } catch (error) {
      this.#error = this.#text("failed", { message: messageOf(error) });
      this.#renderStatus();
    } finally {
      this.#archivedBox.disabled = false;
    }
  }

  /** Merge a settings patch and adopt what the backend reports back. */
  async #saveConfig(patch) {
    const backend = this.#backend();
    if (backend === undefined) throw new Error(this.#text("unavailable"));
    const saved = await backend.request(SET_CONFIG_OPERATION, patch);
    if (saved?.timeFormat !== undefined) this.#timeFormat = normalizeTimeFormat(saved.timeFormat);
    if (typeof saved?.includeArchived === "boolean") this.#includeArchived = saved.includeArchived;
    this.#renderStatus();
  }

  #scheduleRebuildPoll() {
    if (this.#poll !== undefined) clearTimeout(this.#poll);
    const indexing = this.#response?.indexing;
    if (indexing?.rebuilding !== true) return;
    this.#poll = setTimeout(() => {
      this.#poll = undefined;
      if (this.#query.trim() !== "") void this.#search();
    }, REBUILD_POLL_MS);
  }

  async #rebuild() {
    const backend = this.#context?.backend?.forScope?.({ kind: "machine" });
    if (backend === undefined) return;
    this.#rebuildButton.disabled = true;
    try {
      await backend.request(REBUILD_INDEX_OPERATION, {});
    } catch (error) {
      this.#error = this.#text("failed", { message: messageOf(error) });
    } finally {
      this.#rebuildButton.disabled = false;
      if (this.#query.trim() !== "") void this.#search();
      else this.#renderStatus();
    }
  }

  // ---------------------------------------------------------------- navigate

  async #open(hit) {
    const navigate = this.#context?.navigate;
    if (typeof navigate !== "function") return;
    try {
      await navigate(await this.#destination(hit));
    } catch (error) {
      this.#error = this.#text("openFailed", { message: messageOf(error) });
      this.#renderStatus();
    }
  }

  /** A full destination when the session's cwd belongs to a project and workspace. */
  async #destination(hit) {
    const machineId = this.#context?.machine?.id ?? "local";
    const destination = {
      machineId,
      sessionId: hit.sessionId,
      messageEntryId: hit.entryId,
      // A result is a place in a conversation: always land on the chat.
      view: "chat",
    };
    const catalog = this.#context?.catalog;
    const cwd = hit.session?.cwd;
    if (catalog === undefined || typeof cwd !== "string" || cwd === "") return destination;
    try {
      const project = bestPathMatch(await catalog.projects.list(), cwd);
      if (project === undefined) return destination;
      const workspace = bestPathMatch(await catalog.workspaces.list(project.id), cwd);
      if (workspace === undefined) return destination;
      return { ...destination, projectId: project.id, workspaceId: workspace.id };
    } catch {
      // The unscoped session route opens it either way.
      return destination;
    }
  }

  // -------------------------------------------------------------------- view

  #build() {
    const root = this.attachShadow({ mode: "open" });
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    // Carry the module's revision query so the stylesheet is re-fetched when
    // the package changes, and cached under the same revision as the module.
    const stylesheetUrl = new URL("./panel.css", import.meta.url);
    stylesheetUrl.search = new URL(import.meta.url).search;
    stylesheet.href = stylesheetUrl.href;
    root.append(stylesheet);
    const panel = document.createElement("div");
    panel.className = "panel";

    const searchRow = document.createElement("div");
    searchRow.className = "search-row";
    const input = document.createElement("input");
    input.type = "search";
    input.className = "query";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", this.#text("searchLabel"));
    input.addEventListener("input", () => {
      this.#query = input.value;
      rememberedQueries.set(this.#machineId ?? "local", this.#query);
      this.#cursor = undefined;
      this.#schedule();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        if (this.#debounce !== undefined) clearTimeout(this.#debounce);
        this.#debounce = undefined;
        void this.#search();
      }
    });
    searchRow.append(input);
    this.#input = input;

    const status = document.createElement("div");
    status.className = "status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    this.#status = status;

    const results = document.createElement("div");
    results.className = "results";
    results.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest("[data-hit]") : null;
      if (target === null) {
        if (event.target instanceof Element && event.target.closest("[data-load-more]") !== null) void this.#loadMore();
        return;
      }
      const index = Number(target.getAttribute("data-hit"));
      const hit = this.#response?.hits?.[index];
      if (hit !== undefined) void this.#open(hit);
    });
    this.#results = results;

    const footer = document.createElement("div");
    footer.className = "footer";
    const meta = document.createElement("span");
    meta.className = "meta";
    this.#meta = meta;
    const archived = document.createElement("label");
    archived.className = "archived";
    const archivedBox = document.createElement("input");
    archivedBox.type = "checkbox";
    archivedBox.addEventListener("change", () => void this.#saveArchived(archivedBox.checked));
    const archivedLabel = document.createElement("span");
    archived.append(archivedBox, archivedLabel);
    this.#archivedBox = archivedBox;
    this.#archivedLabel = archivedLabel;
    const format = document.createElement("button");
    format.type = "button";
    format.className = "time-format";
    format.addEventListener("click", () => this.#openTimeFormat());
    this.#formatButton = format;
    const rebuild = document.createElement("button");
    rebuild.type = "button";
    rebuild.className = "rebuild";
    rebuild.addEventListener("click", () => void this.#rebuild());
    this.#rebuildButton = rebuild;
    footer.append(meta, archived, format, rebuild);

    const dialog = document.createElement("dialog");
    dialog.className = "time-dialog";
    const heading = document.createElement("h2");
    const label = document.createElement("label");
    const labelText = document.createElement("span");
    const formatInput = document.createElement("input");
    formatInput.type = "text";
    formatInput.className = "format";
    formatInput.autocomplete = "off";
    formatInput.spellcheck = false;
    label.append(labelText, formatInput);
    const hint = document.createElement("p");
    hint.className = "hint";
    const formatError = document.createElement("p");
    formatError.className = "error";
    formatError.setAttribute("role", "alert");
    const actions = document.createElement("div");
    actions.className = "actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "primary";
    actions.append(cancel, save);
    dialog.append(heading, label, hint, formatError, actions);
    cancel.addEventListener("click", () => this.#closeTimeFormat());
    save.addEventListener("click", () => void this.#saveTimeFormat(formatInput.value));
    formatInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      void this.#saveTimeFormat(formatInput.value);
    });
    dialog.addEventListener("click", (event) => {
      // A click on the backdrop targets the dialog element itself.
      if (event.target === dialog) this.#closeTimeFormat();
    });
    this.#formatDialog = dialog;
    this.#formatInput = formatInput;
    this.#formatHeading = heading;
    this.#formatLabel = labelText;
    this.#formatHint = hint;
    this.#formatCancel = cancel;
    this.#formatSave = save;
    this.#formatError = formatError;

    panel.append(searchRow, status, results, footer);
    root.append(panel, dialog);
    this.#renderStatus();
  }

  #renderStatus() {
    if (this.#messages === undefined) return;
    this.#input?.setAttribute("aria-label", this.#text("searchLabel"));
    this.#input?.setAttribute("placeholder", this.#text("placeholder"));
    this.#rebuildButton.textContent = this.#text("rebuild");
    this.#archivedBox.checked = this.#includeArchived;
    this.#archivedLabel.textContent = this.#text("archivedFilter");
    this.#archivedBox.title = this.#text("archivedFilterTitle");
    this.#formatButton.textContent = this.#text("timeFormatButton");
    // The format itself is in the tooltip and prepopulated in the dialog.
    this.#formatButton.title = this.#timeFormat;
    this.#formatHeading.textContent = this.#text("timeFormatTitle");
    this.#formatLabel.textContent = this.#text("timeFormatLabel");
    this.#formatHint.textContent = this.#text("timeFormatHint");
    this.#formatInput.setAttribute("placeholder", DEFAULT_ABSOLUTE_PATTERN);
    this.#formatCancel.textContent = this.#text("cancel");
    this.#formatSave.textContent = this.#text("save");
    const parts = [];
    if (this.#loading) parts.push(this.#text("searching"));
    if (this.#error !== undefined) parts.push(this.#error);
    const indexing = this.#response?.indexing;
    if (indexing?.rebuilding === true) {
      parts.push(indexing.total > 0
        ? this.#text("indexing", { done: indexing.done, total: indexing.total })
        : this.#text("rebuilding"));
    }
    if (this.#query.trim() === "" && parts.length === 0) parts.push(this.#text("emptyQuery"));
    this.#status.textContent = parts.join(" · ");
    if (this.#meta !== undefined) {
      this.#meta.textContent = this.#response === undefined ? "" : this.#summary(this.#response);
    }
  }

  #summary(response) {
    const source = response.source === "index" ? "indexedResults" : "scannedResults";
    const text = this.#text(source, { ms: response.ms ?? 0 });
    if (response.truncated === true) return `${text} · ${this.#text("truncated")}`;
    return text;
  }

  #renderResults() {
    if (this.#messages === undefined) return;
    const hits = this.#response?.hits ?? [];
    const fragment = document.createDocumentFragment();
    if (hits.length === 0) {
      if (this.#error === undefined && !this.#loading && this.#query.trim() !== "") {
        const empty = document.createElement("p");
        empty.className = "empty";
        empty.textContent = this.#text("noResults");
        fragment.append(empty);
      }
    } else {
      let sessionId;
      let group;
      let groupIndex = 0;
      for (let index = 0; index < hits.length; index += 1) {
        const hit = hits[index];
        if (hit.sessionId !== sessionId) {
          sessionId = hit.sessionId;
          group = document.createElement("section");
          group.className = "session-group";
          group.dataset["sessionId"] = sessionId;
          const nameId = `session-group-${groupIndex}`;
          groupIndex += 1;
          group.setAttribute("aria-labelledby", nameId);
          group.append(this.#sessionHeader(hit, nameId));
          fragment.append(group);
        }
        group.append(this.#hitRow(hit, index));
      }
      if (this.#cursor !== undefined) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "load-more";
        more.setAttribute("data-load-more", "");
        more.textContent = this.#text("loadMore");
        fragment.append(more);
      }
    }
    this.#results.replaceChildren(fragment);
  }

  #sessionHeader(hit, nameId) {
    const header = document.createElement("div");
    header.className = "session";
    const name = document.createElement("span");
    name.className = "session-name";
    name.id = nameId;
    name.textContent = hit.session?.name ?? hit.session?.cwd ?? hit.sessionId;
    name.title = hit.sessionId;
    header.append(name);
    if (hit.session?.archived === true) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = this.#text("archived");
      header.append(badge);
    }
    const meta = document.createElement("span");
    meta.className = "session-meta";
    meta.textContent = [hit.session?.cwd, this.#formatTime(hit.session?.modified)].filter(Boolean).join(" · ");
    meta.title = formatTimestamp(hit.session?.modified, DEFAULT_ABSOLUTE_PATTERN, this.#localization);
    header.append(meta);
    return header;
  }

  #hitRow(hit, index) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "hit";
    row.dataset["role"] = hit.role ?? "";
    row.setAttribute("data-hit", String(index));
    // The row's own message time, not the session's last activity: the visible
    // text has no time at all, so the tooltip adds information rather than
    // repeating the header.
    const hitTime = formatTimestamp(hit.timestamp, DEFAULT_ABSOLUTE_PATTERN, this.#localization);
    if (hitTime !== "") row.title = hitTime;
    const role = document.createElement("span");
    role.className = "role";
    role.textContent = this.#roleLabel(hit.role);
    const text = document.createElement("span");
    text.className = "hit-text";
    appendHighlighted(text, hit.snippet ?? "", this.#query.trim());
    row.append(role, text);
    return row;
  }

  #formatTime(iso) {
    return formatTimestamp(iso, this.#timeFormat, this.#localization);
  }

  #roleLabel(role) {
    if (role === "user") return this.#text("user");
    if (role === "assistant") return this.#text("assistant");
    if (role === "tool") return this.#text("question");
    return this.#text("note");
  }

  #text(key, values) {
    const messages = this.#messages;
    if (messages === undefined) return key;
    try {
      return values === undefined ? messages.t(key) : messages.t(key, values);
    } catch {
      return key;
    }
  }
}

function appendHighlighted(container, snippet, query) {
  const index = query === "" ? -1 : snippet.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) {
    container.textContent = snippet;
    return;
  }
  container.append(snippet.slice(0, index));
  const mark = document.createElement("mark");
  mark.textContent = snippet.slice(index, index + query.length);
  container.append(mark, snippet.slice(index + query.length));
}

function bestPathMatch(items, path) {
  let best;
  for (const item of items ?? []) {
    const candidate = typeof item?.path === "string" ? item.path.replace(/\/+$/u, "") : "";
    if (candidate === "") continue;
    if (path !== candidate && !path.startsWith(`${candidate}/`)) continue;
    if (best === undefined || candidate.length > best.path.length) best = item;
  }
  return best;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

