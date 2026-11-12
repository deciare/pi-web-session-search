import { listCandidates } from "./corpus.js";
import { readLines } from "./jsonl.js";
import { isRecord } from "./predicate.js";
import { entryLink } from "./session-file.js";

/**
 * Session summaries read straight from the transcript files.
 *
 * This is the fallback for `sessions_list` while the index is still being built.
 * It reads headers and `session_info` renames only, never message bodies, so it
 * costs a file walk rather than a parse of the corpus.
 */
export async function readSummariesFromFiles(corpus) {
  const candidates = await listCandidates(corpus, { includeArchived: true });
  const summaries = [];
  for (const candidate of candidates) {
    const summary = await readSummaryFromFile(candidate).catch(() => undefined);
    if (summary !== undefined) summaries.push(summary);
  }
  return summaries;
}

async function readSummaryFromFile(candidate) {
  let header;
  let name;
  for await (const line of readLines(candidate.path)) {
    if (line.text === "") continue;
    if (header === undefined) {
      const parsed = tryParse(line.text);
      if (!isRecord(parsed) || parsed["type"] !== "session") return undefined;
      const id = parsed["id"];
      if (typeof id !== "string" || id === "") return undefined;
      header = { id, cwd: typeof parsed["cwd"] === "string" ? parsed["cwd"] : undefined, created: typeof parsed["timestamp"] === "string" ? parsed["timestamp"] : undefined };
      continue;
    }
    const link = entryLink(line.text);
    if (link?.type !== "session_info") continue;
    const parsed = tryParse(line.text);
    if (isRecord(parsed) && typeof parsed["name"] === "string") name = parsed["name"];
  }
  if (header === undefined) return undefined;
  return {
    id: header.id,
    path: candidate.path,
    cwd: header.cwd,
    name: name === "" ? undefined : name,
    created: header.created,
    mtimeMs: candidate.mtimeMs,
    archived: candidate.archived,
  };
}

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
