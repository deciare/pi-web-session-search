/**
 * What counts as a searchable message.
 *
 * The scan and the indexer both call this, by design: two implementations of
 * "searchable" would drift, and the drift would show up as results changing
 * when the index warms up.
 */

/** Raw marker used by the scan's cheap "is there more than one text block" test. */
export const TEXT_BLOCK_MARKER = '"type":"text"';

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

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
