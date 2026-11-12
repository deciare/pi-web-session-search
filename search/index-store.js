import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { readLines } from "./jsonl.js";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { folderViews, foldersOf, projectFor, readCatalog } from "./catalog.js";
import { listCandidates } from "./corpus.js";
import { decodeCursor, encodeCursor, queryFingerprint } from "./cursor.js";
import { buildSessionList, parseListInput } from "./listing.js";
import { scanSessions } from "./scanner.js";
import { activeBranch, readSessionFile } from "./session-file.js";
import { matchSnippet } from "./snippets.js";
import { readSummariesFromFiles } from "./summaries.js";
import { buildHistory, parseHistoryInput, readTranscript } from "./transcript.js";

/**
 * Bump this whenever `predicate.js` changes what is searchable. An index built
 * under an older definition cannot be repaired incrementally: unchanged sessions
 * would keep rows for the old corpus, so the version mismatch is what forces a
 * rebuild.
 */
const SCHEMA_VERSION = 3;
const INSERT_BATCH_ROWS = 250;
const SYNC_INTERVAL_MS = 5000;
const MAX_QUERY_TEXT = 64_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sync_state(
  session_id TEXT PRIMARY KEY,
  path       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  mtime_ms   INTEGER NOT NULL,
  indexed_bytes INTEGER NOT NULL,
  leaf_id    TEXT,
  created    TEXT,
  cwd        TEXT,
  name       TEXT,
  archived   INTEGER NOT NULL DEFAULT 0,
  updated_ms INTEGER NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS hits USING fts5(
  session_id UNINDEXED,
  entry_id UNINDEXED,
  role UNINDEXED,
  ts UNINDEXED,
  position UNINDEXED,
  text,
  tokenize = 'trigram');
CREATE INDEX IF NOT EXISTS sync_state_by_path ON sync_state(path);
PRAGMA user_version = ${SCHEMA_VERSION};
`;

const UPSERT_SYNC = `
INSERT INTO sync_state(session_id, path, size, mtime_ms, indexed_bytes, leaf_id, created, cwd, name, archived, updated_ms)
VALUES(?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(session_id) DO UPDATE SET
  path = excluded.path, size = excluded.size, mtime_ms = excluded.mtime_ms,
  indexed_bytes = excluded.indexed_bytes, leaf_id = excluded.leaf_id, created = excluded.created,
  cwd = excluded.cwd, name = excluded.name, archived = excluded.archived, updated_ms = excluded.updated_ms`;

const PAGE_SQL = (cursor) => `
WITH matched AS (
  SELECT h.session_id AS session_id, h.entry_id AS entry_id, h.role AS role, h.ts AS ts,
         h.position AS position, substr(h.text, 1, ${MAX_QUERY_TEXT}) AS text,
         s.mtime_ms AS mtime_ms, s.cwd AS cwd, s.name AS name, s.archived AS archived,
         COUNT(*) OVER () AS total
  FROM hits h
  JOIN sync_state s ON s.session_id = h.session_id
  WHERE hits MATCH ? AND (? = 1 OR s.archived = 0)
)
SELECT * FROM matched
WHERE 1 = 1${cursor ? `
  AND (mtime_ms < ? OR (mtime_ms = ? AND (session_id > ? OR (session_id = ? AND position > ?))))` : ""}
ORDER BY mtime_ms DESC, session_id ASC, position ASC
LIMIT ?`;

/**
 * The disposable SQLite cache behind search.
 *
 * Truth is the transcripts; this file may vanish, corrupt or be replaced at any
 * instant, and every one of those costs time rather than correctness: a query
 * that cannot use the index is answered by the scan, and a sync pass rebuilds
 * whatever is missing.
 */
export class SearchIndex {
  constructor(options) {
    this.dataDirectory = options.dataDirectory;
    this.corpus = options.corpus;
    this.logger = options.logger;
    this.notices = options.notices;
    this.now = options.now ?? Date.now;
    this.yieldTo = options.yieldTo ?? (() => new Promise((resolve) => setImmediate(resolve)));
    this.dbPath = join(options.dataDirectory, "index.sqlite3");
    this.handles = undefined;
    this.identity = undefined;
    this.completeSinceRestart = false;
    this.permanentlyUnusable = false;
    this.lastError = undefined;
    this.build = { running: false, done: 0, total: 0 };
    this.started = false;
    this.disposed = false;
    this.passQueued = false;
    this.syncTimer = undefined;
    this.intervalTimer = undefined;
    this.logged = new Set();
    this.notified = new Set();
    this.rebuilt = false;
    this.inFlight = undefined;
  }

  start() {
    if (this.started || this.disposed) return;
    this.started = true;
    this.requestSync(0);
    this.intervalTimer = setInterval(() => this.requestSync(0), SYNC_INTERVAL_MS);
    this.intervalTimer.unref?.();
  }

  dispose() {
    this.disposed = true;
    if (this.intervalTimer !== undefined) clearInterval(this.intervalTimer);
    if (this.syncTimer !== undefined) clearTimeout(this.syncTimer);
    this.intervalTimer = undefined;
    this.syncTimer = undefined;
    this.closeHandles();
  }

  requestSync(delayMs = 0) {
    if (this.disposed || this.permanentlyUnusable) return;
    if (this.build.running) {
      this.passQueued = true;
      return;
    }
    if (this.syncTimer !== undefined) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined;
      void this.runPass();
    }, delayMs);
    this.syncTimer.unref?.();
  }

  /** One build pass; never releases a failure. */
  async runPass() {
    if (this.disposed || this.permanentlyUnusable) return;
    if (this.build.running) {
      this.passQueued = true;
      await this.inFlight;
      return;
    }
    this.inFlight = this.runPassOnce();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  async runPassOnce() {
    this.build = { running: true, done: 0, total: 0 };
    try {
      this.openHandles();
      const candidates = await listCandidates(this.corpus, { includeArchived: true });
      this.build.total = candidates.length;
      for (const candidate of candidates) {
        if (this.disposed) return;
        try {
          await this.syncFile(candidate);
        } catch (error) {
          // One unreadable transcript is not a reason to discard the index.
          if (isIndexFailure(error)) throw error;
          this.logOnce(`file:${candidate.path}`, "warn", `could not index ${candidate.path}: ${messageOf(error)}`);
        }
        this.build.done += 1;
        await this.yieldTo();
      }
      this.dropMissing();
      this.completeSinceRestart = true;
      this.lastError = undefined;
      if (this.rebuilt) {
        this.rebuilt = false;
        this.notify("info", "Session search index rebuilt.");
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.build.running = false;
      if (this.passQueued && !this.disposed) {
        this.passQueued = false;
        this.requestSync(0);
      }
    }
  }

  async search(rawInput, signal) {
    const started = this.now();
    const input = parseSearchInput(rawInput);
    let result;
    if (input.query === "") {
      result = { hits: [], total: 0, nextCursor: undefined, truncated: false, source: "scan" };
    } else {
      if (this.canUseIndex(input)) {
        try {
          result = this.queryIndex(input);
        } catch (error) {
          this.fail(error);
        }
      }
      result ??= await this.queryScan(input, signal);
    }
    return { ...result, indexing: this.progress(), ms: Math.round(this.now() - started) };
  }

  progress() {
    return {
      done: this.build.done,
      total: this.build.total,
      rebuilding: !this.completeSinceRestart,
    };
  }

  /** The session catalog: index rows when the index is current, files otherwise. */
  async listSessions(rawInput) {
    const input = parseListInput(rawInput);
    const catalog = await readCatalog(this.corpus.dataDir);
    let summaries;
    if (this.completeSinceRestart && !this.permanentlyUnusable) {
      try {
        summaries = this.summariesFromIndex();
      } catch (error) {
        this.fail(error);
      }
    }
    summaries ??= await readSummariesFromFiles(this.corpus);
    return buildSessionList(summaries, input, catalog);
  }

  /** One session's transcript, shaped and bounded. */
  async readHistory(rawInput) {
    const input = parseHistoryInput(rawInput);
    const catalog = await readCatalog(this.corpus.dataDir);
    const resolved = await this.resolveSession(input.sessionId);
    if (resolved === undefined) throw new Error(`session ${input.sessionId} was not found on this machine`);
    const transcript = await readTranscript(resolved.path);
    const cwd = transcript.header?.cwd;
    const project = projectFor(cwd, catalog.projects);
    const session = {
      id: input.sessionId,
      ...(transcript.name === undefined || transcript.name === "" ? {} : { name: transcript.name }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(transcript.header?.created === undefined ? {} : { created: transcript.header.created }),
      archived: resolved.archived,
      ...(project === undefined ? {} : { project: { id: project.id, name: project.name } }),
      folders: folderViews(foldersOf(input.sessionId, catalog), catalog.folders),
    };
    return buildHistory({ transcript, session, input });
  }

  summariesFromIndex() {
    const { read } = this.readHandle();
    return read.prepare("SELECT session_id, path, mtime_ms, cwd, name, created, archived FROM sync_state").all()
      .map((row) => ({
        id: row.session_id,
        path: row.path,
        cwd: row.cwd ?? undefined,
        name: row.name ?? undefined,
        created: row.created ?? undefined,
        mtimeMs: Number(row.mtime_ms),
        archived: row.archived === 1,
      }));
  }

  /** A session's file, from the index when it knows it, otherwise by filename. */
  async resolveSession(sessionId) {
    if (this.completeSinceRestart && !this.permanentlyUnusable) {
      try {
        const { read } = this.readHandle();
        const row = read.prepare("SELECT path, archived FROM sync_state WHERE session_id = ?").get(sessionId);
        if (row?.path !== undefined) return { path: row.path, archived: row.archived === 1 };
      } catch (error) {
        this.fail(error);
      }
    }
    // Session files are `<timestamp>_<id>.jsonl`; a bare `<id>.jsonl` is accepted
    // too, because the header still has to agree before the file is used.
    const candidates = await listCandidates(this.corpus, { includeArchived: true });
    const names = [`_${sessionId}.jsonl`, `${sessionId}.jsonl`];
    for (const candidate of candidates) {
      if (!names.some((name) => candidate.path.endsWith(name))) continue;
      if (await readHeaderId(candidate.path) === sessionId) {
        return { path: candidate.path, archived: candidate.archived };
      }
    }
    // A renamed file can still be the session; the header is the authority.
    for (const candidate of candidates) {
      if (await readHeaderId(candidate.path) === sessionId) {
        return { path: candidate.path, archived: candidate.archived };
      }
    }
    return undefined;
  }

  async indexStatus() {
    const status = {
      available: !this.permanentlyUnusable,
      complete: this.completeSinceRestart,
      indexing: this.progress(),
      lastError: this.lastError,
      dbPath: this.dbPath,
      corpus: { sessionDir: this.corpus.sessionDir, archiveDir: this.corpus.archiveDir },
      rows: 0,
      sessions: 0,
    };
    if (this.permanentlyUnusable) return status;
    try {
      const { read } = this.openHandles();
      status.rows = count(read, "SELECT count(*) AS n FROM hits");
      status.sessions = count(read, "SELECT count(*) AS n FROM sync_state");
    } catch (error) {
      this.fail(error);
    }
    return status;
  }

  /** Close, delete and rebuild. Returns immediately; progress surfaces through search. */
  async rebuild() {
    this.completeSinceRestart = false;
    this.rebuilt = true;
    this.closeHandles();
    try {
      this.removeIndexFiles();
      this.permanentlyUnusable = false;
    } catch (error) {
      this.permanentlyUnusable = true;
      this.lastError = messageOf(error);
      this.notify("warning", `Session search cannot replace its index file: ${this.lastError}`);
    }
    this.requestSync(0);
    return { started: !this.permanentlyUnusable };
  }

  get indexAvailable() {
    return !this.permanentlyUnusable;
  }

  canUseIndex(input) {
    return input.query.length >= 3 && this.completeSinceRestart && !this.permanentlyUnusable;
  }

  // ---------------------------------------------------------------- querying

  queryIndex(input) {
    const { read } = this.readHandle();
    // Opening may have created a fresh database, which has nothing in it yet.
    if (!this.completeSinceRestart) return undefined;
    const fingerprint = queryFingerprint(input.query, input.includeArchived);
    const cursor = decodeCursor(input.cursor, fingerprint);
    const match = quotePhrase(input.query);
    const limit = input.limit;
    const params = cursor === undefined
      ? [match, input.includeArchived ? 1 : 0, limit + 1]
      : [match, input.includeArchived ? 1 : 0,
        cursor.m, cursor.m, cursor.s, cursor.s, cursor.p, limit + 1];
    const rows = read.prepare(PAGE_SQL(cursor !== undefined)).all(...params);
    const total = rows.length === 0 ? 0 : Number(rows[0].total);
    const page = rows.slice(0, limit);
    const hits = page.map((row) => indexHit(row, input.query));
    const last = page.at(-1);
    const nextCursor = rows.length > limit && last !== undefined
      ? encodeCursor({ v: 1, q: fingerprint, src: "index", m: last.mtime_ms, s: last.session_id, p: last.position })
      : undefined;
    return { hits, total, nextCursor, truncated: false, source: "index" };
  }

  async queryScan(input, signal) {
    const fingerprint = queryFingerprint(input.query, input.includeArchived);
    const cursor = decodeCursor(input.cursor, fingerprint);
    const offset = cursor?.src === "scan" && Number.isInteger(cursor.o) && cursor.o >= 0 ? cursor.o : 0;
    const scan = await scanSessions(this.corpus, input, { signal });
    const flat = [];
    for (const session of scan.sessions) {
      for (const hit of session.hits) {
        flat.push({
          sessionId: session.sessionId,
          entryId: hit.entryId,
          role: hit.role,
          snippet: hit.snippet,
          matchStart: hit.matchStart,
          matchLength: hit.matchLength,
          timestamp: hit.timestamp,
          session: sessionView(session),
        });
      }
    }
    const page = flat.slice(offset, offset + input.limit);
    const nextCursor = offset + page.length < flat.length
      ? encodeCursor({ v: 1, q: fingerprint, src: "scan", o: offset + page.length })
      : undefined;
    return { hits: page, total: scan.total, nextCursor, truncated: scan.truncated, source: "scan" };
  }

  // -------------------------------------------------------------- durability

  openHandles() {
    // A cached handle can outlive the file it points at: a deleted, truncated or
    // replaced index must be noticed before it is written to again.
    if (this.handles !== undefined && !this.handlesMatchFile()) this.closeHandles();
    if (this.handles !== undefined) return this.handles;
    mkdirSync(this.dataDirectory, { recursive: true });
    const existing = statSync(this.dbPath, { throwIfNoEntry: false });
    const existed = existing !== undefined && existing.size > 0;
    let write;
    try {
      write = new DatabaseSync(this.dbPath);
      const version = Number(write.prepare("PRAGMA user_version").get()?.user_version ?? 0);
      if (version !== 0 && version !== SCHEMA_VERSION) throw new Error(`unexpected index schema version ${version}`);
      if (existed) {
        const check = write.prepare("PRAGMA quick_check").get();
        if (check?.quick_check !== "ok") throw new Error(`index integrity check failed: ${check?.quick_check}`);
      }
      write.exec("PRAGMA journal_mode = WAL");
      write.exec("PRAGMA busy_timeout = 5000");
      if (version !== SCHEMA_VERSION) {
        // A fresh database has no rows: whatever was indexed before it is gone.
        this.completeSinceRestart = false;
        write.exec(SCHEMA);
      }
      const read = new DatabaseSync(this.dbPath);
      read.exec("PRAGMA busy_timeout = 5000");
      const info = statSync(this.dbPath);
      this.handles = { write, read };
      this.identity = { dev: info.dev, ino: info.ino };
      return this.handles;
    } catch (error) {
      try {
        write?.close();
      } catch {
        // A handle that cannot close is already lost.
      }
      throw error;
    }
  }

  readHandle() {
    const handles = this.openHandles();
    if (!this.handlesMatchFile()) throw new Error("index file changed or disappeared");
    return handles;
  }

  handlesMatchFile() {
    const info = statSync(this.dbPath, { throwIfNoEntry: false });
    return info !== undefined && info.size > 0 && this.identity !== undefined
      && info.dev === this.identity.dev && info.ino === this.identity.ino;
  }

  closeHandles() {
    if (this.handles === undefined) return;
    for (const handle of [this.handles.read, this.handles.write]) {
      try {
        handle.close();
      } catch {
        // Closing is best effort; the file is disposable either way.
      }
    }
    this.handles = undefined;
    this.identity = undefined;
  }

  removeIndexFiles() {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${this.dbPath}${suffix}`, { force: true });
  }

  fail(error) {
    this.lastError = messageOf(error);
    this.completeSinceRestart = false;
    this.closeHandles();
    try {
      this.removeIndexFiles();
    } catch (removeError) {
      this.permanentlyUnusable = true;
      this.notify("warning", `Session search is answering from transcripts only: ${messageOf(removeError)}`);
    }
    this.logOnce("failure", "warn", `search index unavailable: ${this.lastError}`);
    this.requestSync(0);
  }

  // ------------------------------------------------------------------- sync

  async syncFile(candidate) {
    const { write } = this.openHandles();
    const existing = write.prepare("SELECT * FROM sync_state WHERE path = ?").get(candidate.path);
    let row = existing;
    if (row !== undefined && candidate.size < row.indexed_bytes) row = undefined;
    if (row !== undefined) {
      if (candidate.size === row.indexed_bytes) {
        // An unchanged file is left alone; a rewrite at the same size cannot be
        // trusted to the cursor, because only the bytes moved.
        if (candidate.mtimeMs !== row.mtime_ms) await this.fullIndex(candidate, existing);
        return;
      }
      const increment = await readSessionFile(candidate.path, row.indexed_bytes);
      if (increment.endByte === row.indexed_bytes) {
        this.touch(write, row, candidate);
        return;
      }
      const first = increment.entries[0];
      if (row.leaf_id !== null && first !== undefined && first.parentId === row.leaf_id) {
        await this.appendIncrement(write, row, increment, candidate);
        return;
      }
    }
    await this.fullIndex(candidate, existing);
  }

  touch(write, row, candidate) {
    write.prepare("UPDATE sync_state SET size = ?, mtime_ms = ?, archived = ?, updated_ms = ? WHERE session_id = ?")
      .run(candidate.size, candidate.mtimeMs, candidate.archived ? 1 : 0, this.now(), row.session_id);
  }

  async appendIncrement(write, row, increment, candidate) {
    const branch = activeBranch(increment.entries);
    const rows = increment.messages.filter((message) => branch.has(message.id));
    const leafId = increment.entries.at(-1)?.id ?? row.leaf_id;
    const name = increment.name !== undefined ? normalizeName(increment.name) : row.name;
    write.exec("BEGIN");
    try {
      await this.insertRows(write, row.session_id, rows);
      write.prepare(`${UPSERT_SYNC}`).run(
        row.session_id, candidate.path, candidate.size, candidate.mtimeMs, increment.endByte,
        leafId, row.created, row.cwd, name, candidate.archived ? 1 : 0, this.now(),
      );
      write.exec("COMMIT");
    } catch (error) {
      try {
        write.exec("ROLLBACK");
      } catch {
        // The transaction is gone; the failure path below rebuilds the index.
      }
      throw error;
    }
  }

  async fullIndex(candidate, previous) {
    const { write } = this.openHandles();
    const file = await readSessionFile(candidate.path, 0);
    const id = file.header?.id;
    if (id === undefined) {
      if (previous !== undefined) this.forgetSession(write, previous.session_id);
      return;
    }
    // A path can be reused by a different session; the old session's rows are
    // this path's previous occupant, not the new one's.
    if (previous !== undefined && previous.session_id !== id) this.forgetSession(write, previous.session_id);
    const other = write.prepare("SELECT session_id, path, archived FROM sync_state WHERE session_id = ?").get(id);
    if (other !== undefined && other.path !== candidate.path
      && other.archived !== 1 && candidate.archived && existsSync(other.path)) {
      // A transient archive/live pair: the live copy is the one to search.
      return;
    }
    const branch = activeBranch(file.entries);
    const rows = file.messages.filter((message) => branch.has(message.id));
    write.exec("BEGIN");
    try {
      write.prepare("DELETE FROM hits WHERE session_id = ?").run(id);
      write.prepare("DELETE FROM sync_state WHERE session_id = ?").run(id);
      await this.insertRows(write, id, rows);
      write.prepare(UPSERT_SYNC).run(
        id, candidate.path, candidate.size, candidate.mtimeMs, file.endByte,
        file.entries.at(-1)?.id ?? null, file.header?.timestamp ?? null, file.header?.cwd ?? null,
        normalizeName(file.name), candidate.archived ? 1 : 0, this.now(),
      );
      write.exec("COMMIT");
    } catch (error) {
      try {
        write.exec("ROLLBACK");
      } catch {
        // See appendIncrement.
      }
      throw error;
    }
  }

  forgetSession(write, sessionId) {
    write.exec("BEGIN");
    try {
      write.prepare("DELETE FROM hits WHERE session_id = ?").run(sessionId);
      write.prepare("DELETE FROM sync_state WHERE session_id = ?").run(sessionId);
      write.exec("COMMIT");
    } catch (error) {
      try {
        write.exec("ROLLBACK");
      } catch {
        // The failure path rebuilds the index.
      }
      throw error;
    }
  }

  async insertRows(write, sessionId, rows) {
    if (rows.length === 0) return;
    const insert = write.prepare("INSERT INTO hits(session_id, entry_id, role, ts, position, text) VALUES(?,?,?,?,?,?)");
    for (let index = 0; index < rows.length; index += 1) {
      const message = rows[index];
      insert.run(sessionId, message.id, message.role, message.timestamp ?? null, message.start, message.text);
      if ((index + 1) % INSERT_BATCH_ROWS === 0) await this.yieldTo();
    }
  }

  dropMissing() {
    const { write } = this.openHandles();
    const rows = write.prepare("SELECT session_id, path FROM sync_state").all();
    for (const row of rows) {
      if (existsSync(row.path)) continue;
      this.forgetSession(write, row.session_id);
    }
  }

  logOnce(key, level, message) {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    this.logger?.[level]?.(message);
  }

  notify(severity, message) {
    if (this.notified.has(message)) return;
    this.notified.add(message);
    try {
      this.notices?.record?.({ severity, message });
    } catch {
      // A notice is a courtesy; never let it fail a build.
    }
  }
}

/**
 * Validate one `search` request. Throws TypeError, which the peer surfaces as a
 * failed request rather than an empty page.
 */
export function parseSearchInput(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("search input must be an object");
  const query = typeof value.query === "string" ? value.query.trim() : "";
  const limit = Number.isInteger(value.limit) ? Math.min(Math.max(value.limit, 1), MAX_LIMIT) : DEFAULT_LIMIT;
  const includeArchived = value.includeArchived !== false;
  const cursor = typeof value.cursor === "string" ? value.cursor : undefined;
  return { query, limit, includeArchived, cursor };
}

function indexHit(row, query) {
  const { snippet, matchStart, matchLength } = matchSnippet(row.text, query);
  return {
    sessionId: row.session_id,
    entryId: row.entry_id,
    role: row.role,
    snippet,
    matchStart,
    matchLength,
    timestamp: row.ts ?? undefined,
    session: sessionView({
      cwd: row.cwd,
      name: row.name,
      modifiedMs: Number(row.mtime_ms),
      archived: row.archived === 1,
    }),
  };
}

function sessionView(session) {
  return {
    ...(typeof session.cwd === "string" && session.cwd !== "" ? { cwd: session.cwd } : {}),
    ...(typeof session.name === "string" && session.name !== "" ? { name: session.name } : {}),
    modified: new Date(session.modifiedMs).toISOString(),
    archived: session.archived === true,
  };
}

function quotePhrase(query) {
  return `"${query.replace(/"/gu, '""')}"`;
}

function normalizeName(name) {
  if (name === undefined) return null;
  return name === "" ? null : name;
}

function count(handle, sql) {
  const row = handle.prepare(sql).get();
  return Number(row?.n ?? 0);
}

async function readHeaderId(filePath) {
  for await (const line of readLines(filePath)) {
    try {
      const parsed = JSON.parse(line.text);
      return parsed !== null && typeof parsed === "object" && parsed.type === "session" && typeof parsed.id === "string" ? parsed.id : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Whether a failure is the index's own, which is handled by rebuilding it. */
function isIndexFailure(error) {
  if (typeof error?.errcode === "number") return true;
  const message = messageOf(error);
  return message.startsWith("index ") || message.startsWith("unexpected index");
}
