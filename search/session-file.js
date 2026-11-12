import { readLines } from "./jsonl.js";
import { isRecord, messageText, TEXT_BLOCK_MARKER } from "./predicate.js";

const LINK_PATTERN = /^\{"type":"([a-z_]+)","id":"([^"]+)","parentId":(null|"([^"]+)")/u;

/**
 * Read complete lines from `startByte` into compact records.
 *
 * `header` comes from the first line and is only present when reading from the
 * start of the file. `entries` carries only what the active-branch walk needs;
 * `messages` carries the searchable text of every candidate message, whether or
 * not it ends up on the active branch. `name` is the latest `session_info` name
 * in the range, matching how PI WEB lists sessions; undefined means the range
 * carried no rename.
 *
 * @param {string} filePath
 * @param {number} [startByte]
 */
export async function readSessionFile(filePath, startByte = 0) {
  const entries = [];
  const messages = [];
  let header;
  let name;
  let endByte = startByte;
  let first = startByte === 0;
  for await (const line of readLines(filePath, startByte)) {
    endByte = line.end;
    if (line.text === "") continue;
    if (first) {
      first = false;
      const parsed = tryParse(line.text);
      if (isRecord(parsed) && parsed["type"] === "session") {
        header = {
          id: typeof parsed["id"] === "string" ? parsed["id"] : undefined,
          cwd: typeof parsed["cwd"] === "string" ? parsed["cwd"] : undefined,
          timestamp: typeof parsed["timestamp"] === "string" ? parsed["timestamp"] : undefined,
        };
      }
      continue;
    }
    const link = entryLink(line.text);
    if (link === undefined) continue;
    entries.push({ id: link.id, parentId: link.parentId ?? null, type: link.type, start: line.start });
    if (link.type === "session_info") {
      const parsed = tryParse(line.text);
      if (isRecord(parsed) && typeof parsed["name"] === "string") name = parsed["name"];
      continue;
    }
    if (link.type !== "message") continue;
    const parsed = tryParse(line.text);
    if (!isRecord(parsed)) continue;
    const message = parsed["message"];
    const text = messageText(message);
    if (text === undefined) continue;
    messages.push({
      id: link.id,
      role: String(isRecord(message) ? message["role"] : ""),
      text,
      timestamp: typeof parsed["timestamp"] === "string" ? parsed["timestamp"] : undefined,
      start: line.start,
    });
  }
  return { header, entries, messages, name, endByte };
}

/**
 * The ids on the active root-to-leaf branch. The leaf is the last entry in the
 * file (the branch builder falls back to it when no leaf is named), and the
 * chain is the parent walk back from there.
 *
 * @param {readonly { id: string, parentId: string | null }[]} entries
 */
export function activeBranch(entries) {
  const parentById = new Map();
  let leafId;
  for (const entry of entries) {
    parentById.set(entry.id, entry.parentId);
    leafId = entry.id;
  }
  const branch = new Set();
  let id = leafId;
  while (typeof id === "string" && !branch.has(id)) {
    branch.add(id);
    id = parentById.get(id) ?? undefined;
  }
  return branch;
}

/**
 * `{ type, id, parentId }` from a line, without parsing the body of a message
 * that can be megabytes of tool output.
 *
 * Pi writes `type`, `id` and `parentId` first, so the fast path covers every
 * entry the branch walk cares about. Anything that does not match is parsed in
 * full, which means a changed writer costs correctness nothing.
 *
 * @param {string} line
 */
export function entryLink(line) {
  const match = LINK_PATTERN.exec(line);
  if (match !== null) {
    return { type: match[1], id: match[2], parentId: match[3] === "null" ? null : match[4] };
  }
  if (!line.startsWith('{"type":"')) return undefined;
  const parsed = tryParse(line);
  if (!isRecord(parsed) || typeof parsed["id"] !== "string") return undefined;
  const type = parsed["type"];
  if (type === "session") return undefined;
  const parentId = parsed["parentId"];
  return {
    type: typeof type === "string" ? type : "",
    id: parsed["id"],
    parentId: typeof parentId === "string" ? parentId : null,
  };
}

/**
 * The scan's cheap test: may this line contain a match?
 *
 * A line is worth parsing when the raw bytes contain the needle (the text is
 * stored verbatim, so a line without it cannot contain the term), or when the
 * message has more than one text block and the query could span the join
 * between them. Every other line is skipped without JSON parsing, which is
 * what keeps tool output out of the scan's cost.
 *
 * @param {string} line
 * @param {string} needle lowercased query, or undefined to always parse
 */
export function lineMayMatch(line, needle) {
  if (needle === undefined) return true;
  if (line.toLowerCase().includes(needle)) return true;
  return countOccurrences(line, TEXT_BLOCK_MARKER) > 1;
}

function countOccurrences(haystack, needle) {
  let count = 0;
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + 1)) {
    count += 1;
    if (count > 1) return count;
  }
  return count;
}

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
