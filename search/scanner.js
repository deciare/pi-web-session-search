import { listCandidates } from "./corpus.js";
import { readLines } from "./jsonl.js";
import { entrySearchText, isRecord } from "./predicate.js";
import { activeBranch, entryLink, lineMayMatch } from "./session-file.js";
import { matchSnippet } from "./snippets.js";

export const SCAN_BUDGET_MS = 2000;
export const SCAN_HIT_CAP = 200;
export const HITS_PER_SESSION = 3;

/** Case-insensitive matching is only safe to prefilter on the raw line when the
 * query is plain ASCII: only then is every case variant of the text ASCII too,
 * and only then does the query survive JSON escaping byte for byte. */
const ASCII_ONLY = /^[\u0000-\u007f]*$/u;
const UNSAFE_RAW_CHARACTERS = /["\\\u0000-\u001f]/u;

/**
 * Answer a query by reading the transcripts.
 *
 * This is a permanent code path, not a stepping stone: it is what makes the
 * promise that search never stops working true. The index being absent, cold,
 * corrupt or mid-rebuild costs latency and nothing else.
 *
 * @param {ReturnType<import("./corpus.js").resolveCorpus>} corpus
 * @param {{ query: string, includeArchived: boolean }} input
 */
export async function scanSessions(corpus, input, options = {}) {
  const budgetMs = options.budgetMs ?? SCAN_BUDGET_MS;
  const hitCap = options.hitCap ?? SCAN_HIT_CAP;
  const now = options.now ?? Date.now;
  const signal = options.signal;
  const deadline = now() + budgetMs;
  const needle = asciiPrefilter(input.query);
  const candidates = await listCandidates(corpus, { includeArchived: input.includeArchived });
  const sessions = [];
  const seen = new Set();
  let scannedHits = 0;
  let total = 0;
  let truncated = false;

  for (const candidate of candidates) {
    if (scannedHits >= hitCap) {
      truncated = true;
      break;
    }
    if (aborted(signal) || now() > deadline) {
      truncated = true;
      break;
    }
    let file;
    try {
      file = await scanFile(candidate.path, input.query, needle, deadline, now, signal);
    } catch {
      // A file that cannot be read is not an error the reader should see; the
      // rest of the corpus still answers.
      continue;
    }
    if (file === undefined) {
      truncated = true;
      continue;
    }
    if (file.truncated) {
      truncated = true;
      continue;
    }
    const id = file.header?.id;
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const branch = activeBranch(file.entries);
    const matched = file.messages
      .filter((message) => branch.has(message.id))
      .sort((left, right) => left.start - right.start);
    total += matched.length;
    const hits = matched.slice(0, HITS_PER_SESSION);
    if (hits.length === 0) continue;
    scannedHits += hits.length;
    sessions.push({
      sessionId: id,
      cwd: file.header?.cwd,
      name: file.name,
      modifiedMs: candidate.mtimeMs,
      archived: candidate.archived,
      hits: hits.map((message) => {
        const { snippet, matchStart, matchLength } = matchSnippet(message.text, input.query);
        return {
          entryId: message.id,
          role: message.role,
          timestamp: message.timestamp,
          position: message.start,
          snippet,
          matchStart,
          matchLength,
        };
      }),
    });
  }

  return { sessions, total, truncated, source: "scan" };
}

async function scanFile(path, query, needle, deadline, now, signal) {
  const entries = [];
  const messages = [];
  let header;
  let name;
  let first = true;
  let lines = 0;
  for await (const line of readLines(path)) {
    if ((lines++ & 0x3ff) === 0 && (aborted(signal) || now() > deadline)) {
      return { truncated: true };
    }
    if (line.text === "") continue;
    if (first) {
      first = false;
      const parsed = tryParse(line.text);
      if (isRecord(parsed) && parsed["type"] === "session") {
        header = {
          id: typeof parsed["id"] === "string" ? parsed["id"] : undefined,
          cwd: typeof parsed["cwd"] === "string" ? parsed["cwd"] : undefined,
        };
      }
      continue;
    }
    const link = entryLink(line.text);
    if (link === undefined) continue;
    entries.push({ id: link.id, parentId: link.parentId ?? null });
    if (link.type === "session_info") {
      const parsed = tryParse(line.text);
      if (isRecord(parsed) && typeof parsed["name"] === "string") name = parsed["name"] === "" ? undefined : parsed["name"];
      continue;
    }
    if (link.type !== "message" && link.type !== "custom_message") continue;
    if (!lineMayMatch(line.text, needle)) continue;
    const parsed = tryParse(line.text);
    const searchable = entrySearchText(parsed);
    if (searchable === undefined || !searchable.text.toLowerCase().includes(query.toLowerCase())) continue;
    messages.push({
      id: link.id,
      role: searchable.role,
      text: searchable.text,
      timestamp: typeof parsed["timestamp"] === "string" ? parsed["timestamp"] : undefined,
      start: line.start,
    });
  }
  if (header === undefined) return undefined;
  return { header, entries, messages, name, truncated: false };
}

function asciiPrefilter(query) {
  if (!ASCII_ONLY.test(query)) return undefined;
  if (UNSAFE_RAW_CHARACTERS.test(query)) return undefined;
  return query.toLowerCase();
}

function aborted(signal) {
  return signal?.aborted === true;
}

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
