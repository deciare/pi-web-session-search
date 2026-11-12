import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const T0 = "2026-01-01T00:00:00.000Z";

export async function makeCorpus(prefix = "session-search-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const sessionDir = join(root, "sessions");
  const archiveDir = join(root, "archived");
  await mkdir(join(sessionDir, "--work--"), { recursive: true });
  await mkdir(archiveDir, { recursive: true });
  return { root, sessionDir, archiveDir, dataDir: join(root, "data") };
}

export async function cleanup(corpus) {
  await rm(corpus.root, { recursive: true, force: true });
}

export function sessionHeader(id, cwd = "/work") {
  return { type: "session", version: 3, id, timestamp: T0, cwd };
}

export function textMessage(id, parentId, role, text, timestamp = T0) {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: { role, content: [{ type: "text", text }] },
  };
}

export function contentMessage(id, parentId, role, content, timestamp = T0) {
  return { type: "message", id, parentId, timestamp, message: { role, content } };
}

export function sessionInfo(id, parentId, name, timestamp = T0) {
  return { type: "session_info", id, parentId, timestamp, name };
}

export function compaction(id, parentId, summary, timestamp = T0) {
  return { type: "compaction", id, parentId, timestamp, summary, firstKeptEntryId: id, tokensBefore: 1 };
}

export function customMessage(id, parentId, content, timestamp = T0, { display = true, customType = "test", details } = {}) {
  return { type: "custom_message", id, parentId, timestamp, customType, content, display, ...(details === undefined ? {} : { details }) };
}

export function askResult(id, parentId, details, { content = "Tool finished.", isError = false, timestamp = T0 } = {}) {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: { role: "toolResult", toolName: "ask_user", toolCallId: "call-1", content, details, isError },
  };
}

/**
 * Write a transcript. `entries` are objects; a string is written verbatim, which
 * is how the torn-line case is built.
 */
export async function writeSession(corpus, name, entries, { archived = false } = {}) {
  const directory = archived ? corpus.archiveDir : join(corpus.sessionDir, "--work--");
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  const body = entries.map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(path, body, "utf8");
  return path;
}

export async function appendToSession(path, entries) {
  const body = entries.map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(path, body, { encoding: "utf8", flag: "a" });
}
