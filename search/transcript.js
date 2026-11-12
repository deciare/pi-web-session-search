import { readLines } from "./jsonl.js";
import { isRecord } from "./predicate.js";
import { activeBranch } from "./session-file.js";

/** The whole history response is bounded, not each entry. */
export const HISTORY_BUDGET = 100_000;
const ASK_ANSWERS_TYPE = "pi-web.ask.answers";

/**
 * Read a session file into durable entries, keeping each entry's payload.
 *
 * Unlike the search reader, history needs everything: tool calls, tool output
 * and thinking. Only the header and entry identity are interpreted here; the
 * shaping decisions live in `buildHistory`.
 */
export async function readTranscript(filePath) {
  const entries = [];
  let header;
  let name;
  for await (const line of readLines(filePath)) {
    if (line.text === "") continue;
    const parsed = tryParse(line.text);
    if (!isRecord(parsed)) continue;
    if (parsed["type"] === "session") {
      header = {
        id: typeof parsed["id"] === "string" ? parsed["id"] : undefined,
        cwd: typeof parsed["cwd"] === "string" ? parsed["cwd"] : undefined,
        created: typeof parsed["timestamp"] === "string" ? parsed["timestamp"] : undefined,
      };
      continue;
    }
    const id = parsed["id"];
    if (typeof id !== "string" || id === "") continue;
    entries.push({
      id,
      parentId: typeof parsed["parentId"] === "string" ? parsed["parentId"] : null,
      type: typeof parsed["type"] === "string" ? parsed["type"] : "",
      timestamp: typeof parsed["timestamp"] === "string" ? parsed["timestamp"] : undefined,
      entry: parsed,
    });
    if (parsed["type"] === "session_info" && typeof parsed["name"] === "string") name = parsed["name"];
  }
  return { header, entries, name };
}

/**
 * Validate one `history` request.
 *
 * Exactly one selector: an entry with context turns, a time range, or the last
 * N turns. With none, the last turn is the default, which makes the tool useful
 * with no arguments at all.
 */
export function parseHistoryInput(value) {
  if (!isRecord(value)) throw new TypeError("history input must be an object");
  const sessionId = value["sessionId"];
  if (typeof sessionId !== "string" || sessionId === "") throw new TypeError("history.sessionId must be a non-empty string");

  const entryId = optionalString(value, "entryId");
  const since = optionalInstant(value, "since");
  const until = optionalInstant(value, "until");
  const lastTurns = optionalCount(value, "lastTurns");
  const before = optionalCount(value, "contextTurnsBefore");
  const after = optionalCount(value, "contextTurnsAfter");

  const selectors = [entryId !== undefined, since !== undefined || until !== undefined, lastTurns !== undefined]
    .filter(Boolean).length;
  if (selectors > 1) throw new TypeError("history accepts one of entryId, since/until, or lastTurns");
  if (entryId === undefined && (before !== undefined || after !== undefined)) {
    throw new TypeError("history.contextTurnsBefore and contextTurnsAfter require entryId");
  }
  if (since !== undefined && until !== undefined && since > until) throw new TypeError("history.since is after history.until");

  return {
    sessionId,
    ...(entryId === undefined ? {} : { entryId }),
    contextTurnsBefore: before ?? 1,
    contextTurnsAfter: after ?? 1,
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
    lastTurns: lastTurns ?? 1,
    everything: value["everything"] === true,
  };
}

/**
 * Turns over the active branch. A turn starts at a user message; entries before
 * the first one form a prelude turn with no user entry, so nothing is lost.
 */
export function buildTurns(branchEntries) {
  const turns = [];
  let current;
  for (const entry of branchEntries) {
    if (isUserMessage(entry)) {
      current = { index: turns.length, userEntryId: entry.id, entries: [] };
      turns.push(current);
    } else if (current === undefined) {
      current = { index: 0, userEntryId: null, entries: [] };
      turns.push(current);
    }
    current.entries.push(entry);
  }
  return turns;
}

/**
 * Shape the selected turns into flat, chronological entries.
 *
 * `everything` adds thinking, tool calls, tool output and compaction summaries;
 * the default is the conversation: text, ask cards and displayed host notes.
 */
export function buildHistory({ transcript, session, input, budget = HISTORY_BUDGET }) {
  const branch = new Set(activeBranch(transcript.entries.map((entry) => ({ id: entry.id, parentId: entry.parentId }))));
  const branchEntries = transcript.entries.filter((entry) => branch.has(entry.id));
  const turns = buildTurns(branchEntries);
  const selected = selectTurns(turns, input);
  const answers = collectAskAnswers(branchEntries);

  let shaped = [];
  for (const turn of selected) {
    for (const entry of turn.entries) shaped.push(...shapeEntry(entry, turn.index, input.everything, answers));
  }
  if (input.since !== undefined || input.until !== undefined) {
    shaped = shaped.filter((entry) => withinRange(entry, input.since, input.until));
  }
  const bounded = applyBudget(shaped, budget);
  return { session, entries: bounded.entries, truncated: bounded.truncated, omitted: bounded.omitted };
}

/** Selected turns, by selector; a range selector keeps every turn and filters entries later. */
export function selectTurns(turns, input) {
  if (input.entryId !== undefined) {
    const index = turns.findIndex((turn) => turn.entries.some((entry) => entry.id === input.entryId));
    if (index === -1) throw new Error(`entry ${input.entryId} is not on this session's active branch`);
    return turns.slice(Math.max(0, index - input.contextTurnsBefore), index + input.contextTurnsAfter + 1);
  }
  if (input.since !== undefined || input.until !== undefined) return turns;
  return turns.slice(Math.max(0, turns.length - input.lastTurns));
}

/** Whole entries, in order, until the next would cross the budget. */
export function applyBudget(entries, budget = HISTORY_BUDGET) {
  const selected = [];
  let used = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const size = JSON.stringify(entries[index]).length;
    if (used + size > budget) return { entries: selected, truncated: true, omitted: entries.length - index };
    selected.push(entries[index]);
    used += size;
  }
  return { entries: selected, truncated: false, omitted: 0 };
}

function shapeEntry(entry, turnIndex, everything, answers) {
  const base = {
    entryId: entry.id,
    turnIndex,
    ...(entry.timestamp === undefined ? {} : { timestamp: entry.timestamp }),
  };
  if (entry.type === "custom_message") {
    if (entry.entry["display"] !== true) return [];
    const content = entry.entry["content"];
    return typeof content === "string" && content !== "" ? [{ ...base, role: "system", kind: "note", text: content }] : [];
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    if (!everything) return [];
    const summary = entry.entry["summary"];
    return typeof summary === "string" && summary !== ""
      ? [{ ...base, role: "system", kind: "compaction", text: summary, ...(entry.type === "branch_summary" ? { branch: true } : {}) }]
      : [];
  }
  if (entry.type !== "message") return [];
  const message = entry.entry["message"];
  if (!isRecord(message)) return [];
  const role = typeof message["role"] === "string" ? message["role"] : "";

  if (role === "user" || role === "assistant") {
    const content = message["content"];
    if (typeof content === "string") return content === "" ? [] : [{ ...base, role, kind: "text", text: content }];
    if (!Array.isArray(content)) return [];
    const blocks = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      const type = block["type"];
      if (type === "text") {
        if (typeof block["text"] === "string" && block["text"] !== "") blocks.push({ ...base, role, kind: "text", text: block["text"] });
      } else if (type === "thinking") {
        if (everything && typeof block["thinking"] === "string" && block["thinking"] !== "") blocks.push({ ...base, role, kind: "thinking", text: block["thinking"] });
      } else if (type === "toolCall") {
        if (everything) blocks.push({ ...base, role, kind: "toolCall", tool: { name: stringOr(block["name"], "tool"), arguments: block["arguments"] ?? null } });
      } else if (type === "image") {
        blocks.push({ ...base, role, kind: "text", text: `[image ${stringOr(block["mimeType"], "image")}]` });
      } else if (everything) {
        blocks.push({ ...base, role, kind: "text", text: `[${stringOr(type, "unknown")}]` });
      }
    }
    return blocks;
  }

  if (role === "toolResult") {
    const asks = askBlocks(message, answers);
    if (asks.length > 0) return asks.map((ask) => ({ ...base, role: "tool", kind: "ask", ask }));
    if (!everything) return [];
    return [{
      ...base,
      role: "tool",
      kind: "toolResult",
      tool: {
        name: stringOr(message["toolName"], "tool"),
        isError: message["isError"] === true,
        output: toolOutput(message["content"]),
      },
    }];
  }
  return [];
}

/** One card per ask payload this result carries: the request, and any superseded record. */
function askBlocks(message, answers) {
  if (message["toolName"] !== "ask_user" || message["isError"] === true) return [];
  const details = message["details"];
  if (!isRecord(details)) return [];
  const blocks = [];

  const ask = details["ask"];
  if (isRecord(ask) && Array.isArray(ask["questions"])) {
    const askId = stringOr(ask["askId"], "");
    const records = answers.get(askId);
    blocks.push({
      askId,
      questions: ask["questions"].map((question) => questionView(question, records)).filter((view) => view !== undefined),
    });
  }

  const superseded = details["superseded"];
  if (isRecord(superseded) && Array.isArray(superseded["questions"])) {
    const records = new Map();
    for (const record of superseded["questions"]) {
      if (!isRecord(record) || !isRecord(record["question"])) continue;
      records.set(stringOr(record["question"]["id"], ""), record);
    }
    blocks.push({
      askId: stringOr(superseded["askId"], ""),
      questions: superseded["questions"]
        .map((record) => isRecord(record) ? questionView(record["question"], records, record) : undefined)
        .filter((view) => view !== undefined),
    });
  }
  return blocks;
}

function questionView(question, answerRecords, record) {
  if (!isRecord(question)) return undefined;
  const options = Array.isArray(question["options"]) ? question["options"] : [];
  const labels = options.flatMap((option) => isRecord(option) && typeof option["label"] === "string" ? [option["label"]] : []);
  const record_ = record ?? (answerRecords instanceof Map ? answerRecords.get(stringOr(question["id"], "")) : undefined);
  const values = Array.isArray(record_?.["values"]) ? record_["values"] : [];
  const chosen = values.flatMap((value) => {
    const option = options.find((candidate) => isRecord(candidate) && candidate["value"] === value);
    if (isRecord(option) && typeof option["label"] === "string") return [option["label"]];
    return typeof value === "string" && value !== "" ? [value] : [];
  });
  return {
    id: stringOr(question["id"], ""),
    question: stringOr(question["question"], ""),
    ...(typeof question["detail"] === "string" && question["detail"] !== "" ? { detail: question["detail"] } : {}),
    ...(question["multiple"] === true ? { multiple: true } : {}),
    options: labels,
    ...(chosen.length === 0 ? {} : { chosen }),
    ...(typeof record_?.["otherText"] === "string" && record_["otherText"] !== "" ? { otherText: record_["otherText"] } : {}),
    ...(typeof record_?.["comment"] === "string" && record_["comment"] !== "" ? { comment: record_["comment"] } : {}),
  };
}

/** Ask outcomes are notes in the transcript; index them by askId for the cards. */
function collectAskAnswers(branchEntries) {
  const answers = new Map();
  for (const entry of branchEntries) {
    if (entry.type !== "custom_message" || entry.entry["customType"] !== ASK_ANSWERS_TYPE) continue;
    const details = entry.entry["details"];
    if (!isRecord(details) || !Array.isArray(details["questions"])) continue;
    const records = new Map();
    for (const record of details["questions"]) {
      if (!isRecord(record) || !isRecord(record["question"])) continue;
      records.set(stringOr(record["question"]["id"], ""), record);
    }
    answers.set(stringOr(details["askId"], ""), records);
  }
  return answers;
}

function isUserMessage(entry) {
  if (entry.type !== "message") return false;
  const message = entry.entry["message"];
  return isRecord(message) && message["role"] === "user";
}

function withinRange(entry, since, until) {
  const instant = entry.timestamp === undefined ? undefined : Date.parse(entry.timestamp);
  if (instant === undefined || !Number.isFinite(instant)) return false;
  if (since !== undefined && instant < since) return false;
  if (until !== undefined && instant > until) return false;
  return true;
}

function toolOutput(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => {
    if (!isRecord(block)) return [];
    if (block["type"] === "text" && typeof block["text"] === "string") return [block["text"]];
    if (block["type"] === "image") return ["[image]"];
    return [];
  }).join("\n");
}

function optionalString(value, key) {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "string" || field === "") throw new TypeError(`history.${key} must be a non-empty string`);
  return field;
}

function optionalInstant(value, key) {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "string" || field === "") throw new TypeError(`history.${key} must be an ISO timestamp`);
  const instant = Date.parse(field);
  if (!Number.isFinite(instant)) throw new TypeError(`history.${key} must be an ISO timestamp`);
  return instant;
}

function optionalCount(value, key) {
  const field = value[key];
  if (field === undefined) return undefined;
  if (!Number.isInteger(field) || field < 0) throw new TypeError(`history.${key} must be a non-negative integer`);
  return field;
}

function stringOr(value, fallback) {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
