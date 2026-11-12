/**
 * What counts as searchable text.
 *
 * The scan and the indexer both call this, by design: two implementations of
 * "searchable" would drift, and the drift would show up as results changing
 * when the index warms up.
 *
 * The corpus is the visible conversation: user and assistant text, ask cards,
 * and the notes the host displays in the transcript. Tool inputs, tool output,
 * thinking blocks and system messages are not in it, and neither are entries the
 * transcript keeps hidden.
 */

/** Raw marker used by the scan's cheap "is there more than one text block" test. */
export const TEXT_BLOCK_MARKER = '"type":"text"';

const ASK_USER_TOOL = "ask_user";

const SEARCHABLE_ROLES = new Set(["user", "assistant"]);

/**
 * The message text as the transcript displays it, or undefined when the message
 * is not searchable.
 *
 * Structural, not textual: only `user` and `assistant` messages, and only
 * `type: "text"` blocks. Thinking blocks, tool calls, tool results and system
 * messages (including compaction summaries, which are not messages at all) are
 * outside the corpus.
 *
 * @param {unknown} message
 * @returns {string | undefined}
 */
export function messageText(message) {
  if (!isRecord(message)) return undefined;
  const role = message["role"];
  if (typeof role !== "string" || !SEARCHABLE_ROLES.has(role)) return undefined;
  const content = message["content"];
  if (typeof content === "string") return content === "" ? undefined : content;
  if (!Array.isArray(content)) return undefined;
  const parts = [];
  for (const block of content) {
    if (!isRecord(block) || block["type"] !== "text") continue;
    const text = block["text"];
    if (typeof text === "string" && text !== "") parts.push(text);
  }
  return parts.length === 0 ? undefined : parts.join("\n\n");
}

/**
 * The searchable text of one transcript entry, or undefined when the entry is
 * outside the corpus.
 *
 * - `user` and `assistant` messages: their `type: "text"` blocks.
 * - A successful `ask_user` tool result: the question card it renders. The card
 *   is built from persisted `details`, not from the tool call, and its model-
 *   facing output is not included.
 * - A displayed custom message (the host's own transcript note, such as the
 *   answer summary): its content.
 *
 * `role` is the role the transcript renders, so a hit can be labelled and its
 * row found by entry id like any other line.
 *
 * @param {unknown} entry
 * @returns {{ role: string, text: string } | undefined}
 */
export function entrySearchText(entry) {
  if (!isRecord(entry)) return undefined;
  if (entry["type"] === "custom_message") {
    if (entry["display"] !== true) return undefined;
    const content = entry["content"];
    return typeof content === "string" && content !== "" ? { role: "system", text: content } : undefined;
  }
  if (entry["type"] !== "message") return undefined;
  const message = entry["message"];
  const text = messageText(message);
  if (text !== undefined) return { role: String(isRecord(message) ? message["role"] : ""), text };
  const card = askCardText(message);
  return card === undefined ? undefined : { role: "tool", text: card };
}

function askCardText(message) {
  if (!isRecord(message)) return undefined;
  if (message["role"] !== "toolResult" || message["toolName"] !== ASK_USER_TOOL || message["isError"] === true) return undefined;
  const details = message["details"];
  if (!isRecord(details)) return undefined;
  const parts = [];
  appendAskRequest(parts, details["ask"]);
  appendAskOutcome(parts, details["superseded"]);
  return parts.length === 0 ? undefined : parts.join("\n");
}

function appendAskRequest(parts, ask) {
  if (!isRecord(ask) || !Array.isArray(ask["questions"])) return;
  for (const question of ask["questions"]) appendQuestion(parts, question);
}

function appendAskOutcome(parts, outcome) {
  if (!isRecord(outcome) || !Array.isArray(outcome["questions"])) return;
  for (const record of outcome["questions"]) {
    if (!isRecord(record)) continue;
    appendQuestion(parts, record["question"]);
    const chosen = chosenLabels(record);
    if (chosen.length > 0) parts.push(chosen.join(", "));
    if (typeof record["otherText"] === "string" && record["otherText"] !== "") parts.push(record["otherText"]);
    if (typeof record["comment"] === "string" && record["comment"] !== "") parts.push(record["comment"]);
  }
}

/** Question text, its supporting line, and the option labels the card offers. */
function appendQuestion(parts, question) {
  if (!isRecord(question)) return;
  if (typeof question["question"] === "string" && question["question"] !== "") parts.push(question["question"]);
  if (typeof question["detail"] === "string" && question["detail"] !== "") parts.push(question["detail"]);
  if (!Array.isArray(question["options"])) return;
  for (const option of question["options"]) {
    if (isRecord(option) && typeof option["label"] === "string" && option["label"] !== "") parts.push(option["label"]);
  }
}

function chosenLabels(record) {
  const options = isRecord(record["question"]) && Array.isArray(record["question"]["options"]) ? record["question"]["options"] : [];
  const labels = [];
  for (const value of Array.isArray(record["values"]) ? record["values"] : []) {
    const option = options.find((candidate) => isRecord(candidate) && candidate["value"] === value);
    if (isRecord(option) && typeof option["label"] === "string") labels.push(option["label"]);
    else if (typeof value === "string" && value !== "") labels.push(value);
  }
  return labels;
}

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
