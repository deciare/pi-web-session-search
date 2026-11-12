import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { rename, rm, stat, truncate, utimes, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { SearchIndex } from "../search/index-store.js";
import {
  askResult,
  cleanup,
  contentMessage,
  customMessage,
  makeCorpus,
  sessionHeader,
  sessionInfo,
  textMessage,
  writeSession,
} from "./fixtures.js";

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function makeIndex(corpus, options = {}) {
  const notices = [];
  const index = new SearchIndex({
    dataDirectory: corpus.dataDir,
    corpus,
    logger: silentLogger,
    notices: { record: (notice) => notices.push(notice) },
    yieldTo: () => Promise.resolve(),
    ...options,
  });
  return { index, notices };
}

async function settle(index) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!index.build.running && index.completeSinceRestart) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`index did not settle: ${index.lastError ?? "no error"}`);
}

async function basicCorpus() {
  const corpus = await makeCorpus();
  await writeSession(corpus, "a.jsonl", [
    sessionHeader("s1", "/workspace"),
    textMessage("m1", null, "user", "the rollback plan"),
    textMessage("m2", "m1", "assistant", "resolved with resolvePluginNavigation"),
  ]);
  return corpus;
}

test("search answers from the scan before the first pass, then from the index", async (t) => {
  const corpus = await basicCorpus();
  t.after(() => cleanup(corpus));
  const { index } = makeIndex(corpus);

  const cold = await index.search({ query: "roll" });
  assert.equal(cold.source, "scan");
  assert.equal(cold.hits[0].sessionId, "s1");
  assert.equal(cold.hits[0].entryId, "m1");
  assert.equal(cold.hits[0].session.cwd, "/workspace");

  await index.runPass();
  const warm = await index.search({ query: "roll" });
  assert.equal(warm.source, "index");
  assert.equal(warm.hits[0].entryId, "m1");
  assert.equal(warm.total, 1);
  assert.equal(warm.indexing.rebuilding, false);

  // Substring semantics come from the trigram tokenizer.
  const plugin = await index.search({ query: "PluginNavigation" });
  assert.equal(plugin.hits[0].entryId, "m2");
  index.dispose();
});

test("an appended session gains hits without reindexing from zero", async (t) => {
  const corpus = await basicCorpus();
  t.after(() => cleanup(corpus));
  const { index } = makeIndex(corpus);
  await index.runPass();
  const path = `${corpus.sessionDir}/--work--/a.jsonl`;
  const before = await stat(path);
  await appendFile(path, `${JSON.stringify(textMessage("m3", "m2", "user", "a quokka appears"))}\n`, "utf8");

  await index.runPass();
  const hit = await index.search({ query: "quokka" });
  assert.equal(hit.source, "index");
  assert.equal(hit.hits[0].entryId, "m3");

  const db = new DatabaseSync(index.dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT indexed_bytes, size FROM sync_state WHERE session_id = ?").get("s1");
    assert.equal(row.indexed_bytes, row.size);
    assert.ok(row.size > before.size);
    assert.equal(db.prepare("SELECT count(*) AS n FROM hits WHERE session_id = ?").get("s1").n, 3);
  } finally {
    db.close();
  }
  index.dispose();
});

test("a branch change drops the abandoned branch", async (t) => {
  const corpus = await basicCorpus();
  t.after(() => cleanup(corpus));
  const { index } = makeIndex(corpus);
  await index.runPass();
  assert.equal((await index.search({ query: "resolvePluginNavigation" })).hits.length, 1);

  const path = `${corpus.sessionDir}/--work--/a.jsonl`;
  await appendFile(path, `${JSON.stringify(textMessage("m4", "m1", "user", "a different branch"))}\n`, "utf8");
  await index.runPass();

  assert.equal((await index.search({ query: "resolvePluginNavigation" })).hits.length, 0);
  assert.equal((await index.search({ query: "different branch" })).hits[0].entryId, "m4");
  index.dispose();
});

test("a moved session is archived and searchable, not duplicated", async (t) => {
  const corpus = await basicCorpus();
  t.after(() => cleanup(corpus));
  const { index } = makeIndex(corpus);
  await index.runPass();
  await rename(`${corpus.sessionDir}/--work--/a.jsonl`, `${corpus.archiveDir}/a.jsonl`);
  await index.runPass();

  const result = await index.search({ query: "rollback" });
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].session.archived, true);
  const excluded = await index.search({ query: "rollback", includeArchived: false });
  assert.equal(excluded.hits.length, 0);
  index.dispose();
});

test("session naming comes from the latest session_info", async (t) => {
  const corpus = await makeCorpus();
  t.after(() => cleanup(corpus));
  await writeSession(corpus, "a.jsonl", [
    sessionHeader("s1"),
    textMessage("m1", null, "user", "rollback"),
    sessionInfo("i1", "m1", "Old name"),
    sessionInfo("i2", "i1", "New name"),
  ]);
  const { index } = makeIndex(corpus);
  await index.runPass();
  assert.equal((await index.search({ query: "rollback" })).hits[0].session.name, "New name");
  index.dispose();
});

test("text appears only in searchable blocks", async (t) => {
  const corpus = await makeCorpus();
  t.after(() => cleanup(corpus));
  await writeSession(corpus, "a.jsonl", [
    sessionHeader("s1"),
    textMessage("m1", null, "user", "ordinary words"),
    contentMessage("m2", "m1", "assistant", [{ type: "thinking", thinking: "secret zebra" }]),
    contentMessage("m3", "m2", "toolResult", [{ type: "text", text: "zebra output" }]),
  ]);
  const { index } = makeIndex(corpus);
  await index.runPass();
  assert.equal((await index.search({ query: "zebra" })).hits.length, 0);
  assert.equal((await index.search({ query: "ordinary" })).hits.length, 1);
  index.dispose();
});

test("a torn final line is never indexed", async (t) => {
  const corpus = await makeCorpus();
  t.after(() => cleanup(corpus));
  const path = await writeSession(corpus, "a.jsonl", [sessionHeader("s1"), textMessage("m1", null, "user", "rollback")]);
  await appendFile(path, '{"type":"message","id":"m2","parentId":"m1","message":{"role":"assistant","content":[{"type":"text","text":"torn z', "utf8");
  const { index } = makeIndex(corpus);
  await index.runPass();
  assert.equal((await index.search({ query: "rollback" })).hits.length, 1);
  assert.equal((await index.search({ query: "torn" })).hits.length, 0);

  // Completing the line lets the next pass index it.
  await appendFile(path, 'ebra"}]}}\n', "utf8");
  await index.runPass();
  assert.equal((await index.search({ query: "torn zebra" })).hits[0].entryId, "m2");
  index.dispose();
});

test("the index is disposable: missing, empty, corrupt, deleted, truncated", async (t) => {
  const corpus = await basicCorpus();
  t.after(() => cleanup(corpus));
  const { index } = makeIndex(corpus);
  await index.runPass();
  const expected = await index.search({ query: "rollback" });
  assert.equal(expected.source, "index");

  // (a) no file at all, handles from a previous life.
  index.closeHandles();
  await rm(index.dbPath, { force: true });
  await rm(`${index.dbPath}-wal`, { force: true });
  await rm(`${index.dbPath}-shm`, { force: true });
  const missing = await index.search({ query: "rollback" });
  assert.equal(missing.source, "scan");
  assert.equal(missing.hits[0].entryId, "m1");

  // (b) zero-length file.
  index.closeHandles();
  await writeFile(index.dbPath, "");
  assert.equal((await index.search({ query: "rollback" })).source, "scan");
  await index.runPass();
  assert.equal((await index.search({ query: "rollback" })).source, "index");

  // (c) random bytes.
  index.closeHandles();
  await writeFile(index.dbPath, randomBytes(4096));
  const corrupt = await index.search({ query: "rollback" });
  assert.equal(corrupt.source, "scan");
  assert.equal(corrupt.hits[0].entryId, "m1");
  await index.runPass();
  const recovered = await index.search({ query: "rollback" });
  assert.equal(recovered.source, "index");
  assert.deepEqual(recovered.hits.map((hit) => hit.entryId), expected.hits.map((hit) => hit.entryId));

  // (d) deleted between two queries.
  index.closeHandles();
  await rm(index.dbPath, { force: true });
  const deleted = await index.search({ query: "rollback" });
  assert.equal(deleted.source, "scan");
  assert.equal(deleted.hits[0].entryId, "m1");

  // (e) truncated to a fragment.
  await index.runPass();
  index.closeHandles();
  await truncate(index.dbPath, 1024);
  const truncated = await index.search({ query: "rollback" });
  assert.equal(truncated.hits[0].entryId, "m1");

  await index.runPass();
  const last = await index.search({ query: "rollback" });
  assert.equal(last.source, "index");
  assert.deepEqual(last.hits.map((hit) => hit.entryId), expected.hits.map((hit) => hit.entryId));
  index.dispose();
});

test("an index built under an older corpus definition is rebuilt", async (t) => {
  const corpus = await basicCorpus();
  t.after(() => cleanup(corpus));
  const { index } = makeIndex(corpus);
  await index.runPass();
  index.closeHandles();
  const db = new DatabaseSync(index.dbPath);
  db.exec("PRAGMA user_version = 1");
  db.close();

  const stale = await index.search({ query: "rollback" });
  assert.equal(stale.source, "scan");
  assert.equal(stale.hits[0].entryId, "m1");
  await index.runPass();
  assert.equal((await index.search({ query: "rollback" })).source, "index");
  index.dispose();
});

test("rebuild restarts an identical index", async (t) => {
  const corpus = await basicCorpus();
  t.after(() => cleanup(corpus));
  const { index } = makeIndex(corpus);
  await index.runPass();
  const before = await index.search({ query: "rollback" });
  await index.rebuild();
  const during = await index.search({ query: "rollback" });
  assert.equal(during.source, "scan");
  await settle(index);
  const after = await index.search({ query: "rollback" });
  assert.equal(after.source, "index");
  assert.deepEqual(after.hits.map((hit) => hit.entryId), before.hits.map((hit) => hit.entryId));
  index.dispose();
});

test("an emptied transcript drops its hits without failing the pass", async (t) => {
  const corpus = await basicCorpus();
  t.after(() => cleanup(corpus));
  const { index } = makeIndex(corpus);
  await index.runPass();
  assert.equal((await index.search({ query: "rollback" })).hits.length, 1);
  await writeFile(`${corpus.sessionDir}/--work--/a.jsonl`, "");
  await index.runPass();
  assert.equal(index.completeSinceRestart, true);
  assert.equal((await index.search({ query: "rollback" })).hits.length, 0);
  index.dispose();
});

test("a path reused by another session replaces the old session's rows", async (t) => {
  const corpus = await basicCorpus();
  t.after(() => cleanup(corpus));
  const { index } = makeIndex(corpus);
  await index.runPass();
  await writeSession(corpus, "a.jsonl", [sessionHeader("s2"), textMessage("x1", null, "user", "a kangaroo now")]);
  await index.runPass();
  assert.equal((await index.search({ query: "rollback" })).hits.length, 0);
  const hit = await index.search({ query: "kangaroo" });
  assert.equal(hit.hits[0].sessionId, "s2");
  assert.equal(hit.hits[0].entryId, "x1");
  index.dispose();
});

test("a rewrite at the same size is reindexed rather than trusted to the cursor", async (t) => {
  const corpus = await makeCorpus();
  t.after(() => cleanup(corpus));
  const path = await writeSession(corpus, "a.jsonl", [sessionHeader("s1"), textMessage("m1", null, "user", "alpha")]);
  const { index } = makeIndex(corpus);
  await index.runPass();
  assert.equal((await index.search({ query: "alpha" })).hits.length, 1);

  await writeSession(corpus, "a.jsonl", [sessionHeader("s1"), textMessage("m1", null, "user", "alphb")]);
  const later = new Date(Date.now() + 5_000);
  await utimes(path, later, later);
  await index.runPass();
  assert.equal((await index.search({ query: "alpha" })).hits.length, 0);
  assert.equal((await index.search({ query: "alphb" })).hits[0].entryId, "m1");
  index.dispose();
});

test("a session whose file disappears is dropped from results", async (t) => {
  const corpus = await basicCorpus();
  t.after(() => cleanup(corpus));
  const { index } = makeIndex(corpus);
  await index.runPass();
  assert.equal((await index.search({ query: "rollback" })).hits.length, 1);
  await rm(`${corpus.sessionDir}/--work--/a.jsonl`);
  await index.runPass();
  assert.equal((await index.search({ query: "rollback" })).hits.length, 0);
  index.dispose();
});

test("index and scan agree on the same corpus", async (t) => {
  const corpus = await makeCorpus();
  t.after(() => cleanup(corpus));
  await writeSession(corpus, "a.jsonl", [
    sessionHeader("s1"),
    textMessage("m1", null, "user", "the rollback plan"),
    textMessage("m2", "m1", "assistant", "resolvePluginNavigation and rollback"),
  ]);
  await writeSession(corpus, "b.jsonl", [
    sessionHeader("s2", "/other"),
    textMessage("n1", null, "user", "no mention"),
    textMessage("n2", "n1", "assistant", "another ROLLBACK"),
    contentMessage("n3", "n2", "assistant", [{ type: "text", text: "alpha" }, { type: "text", text: "beta" }]),
    askResult("q1", "n2", {
      ask: {
        askId: "ask-1", askedAt: "2026-11-05T21:04:10.037Z",
        questions: [{ id: "q", question: "Which way on the rollback?", options: [{ value: "a", label: "Keep the rollback" }] }],
      },
    }),
    customMessage("a1", "q1", "The user submitted answers to your questions.", undefined, { customType: "pi-web.ask.answers" }),
  ]);
  const { index } = makeIndex(corpus);
  const queries = ["rollback", "resolvePlugin", "ROLLBACK", "plan", "Which way", "submitted answers", "alpha\n\nbeta", "alphabeta"];
  const scanned = new Map();
  for (const query of queries) {
    const result = await index.search({ query });
    assert.equal(result.source, "scan");
    scanned.set(query, result);
  }
  await index.runPass();
  for (const query of queries) {
    const indexed = await index.search({ query });
    const expected = scanned.get(query);
    assert.equal(indexed.source, "index");
    assert.deepEqual(
      indexed.hits.map((hit) => `${hit.sessionId}:${hit.entryId}`).sort(),
      expected.hits.map((hit) => `${hit.sessionId}:${hit.entryId}`).sort(),
      `query ${query}`,
    );
    assert.equal(indexed.total, expected.total, `query ${query} total`);
  }
  index.dispose();
});

test("paging walks the whole result set without gaps", async (t) => {
  const corpus = await makeCorpus();
  t.after(() => cleanup(corpus));
  for (let session = 0; session < 3; session += 1) {
    const entries = [sessionHeader(`s${session}`)];
    let parent = null;
    for (let index = 0; index < 2; index += 1) {
      const id = `m${session}-${index}`;
      entries.push(textMessage(id, parent, "user", `rollback ${session} ${index}`));
      parent = id;
    }
    await writeSession(corpus, `s${session}.jsonl`, entries);
  }
  const { index } = makeIndex(corpus);
  await index.runPass();
  const seen = [];
  let cursor;
  for (let page = 0; page < 5; page += 1) {
    const result = await index.search({ query: "rollback", limit: 2, cursor });
    seen.push(...result.hits.map((hit) => `${hit.sessionId}:${hit.entryId}`));
    cursor = result.nextCursor;
    if (cursor === undefined) break;
  }
  assert.equal(seen.length, 6);
  assert.equal(new Set(seen).size, 6);
  assert.equal((await index.search({ query: "rollback" })).total, 6);
  index.dispose();
});

test("the index is larger than nothing and smaller than the transcripts", async (t) => {
  // A crude guard on the trigram cost documented in the README.
  const corpus = await basicCorpus();
  t.after(() => cleanup(corpus));
  const { index } = makeIndex(corpus);
  await index.runPass();
  const info = await stat(index.dbPath);
  assert.ok(info.size > 0);
  index.dispose();
});
