import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, writeFile } from "node:fs/promises";
import { scanSessions } from "../search/scanner.js";
import {
  askResult,
  cleanup,
  compaction,
  contentMessage,
  customMessage,
  makeCorpus,
  sessionHeader,
  textMessage,
  writeSession,
} from "./fixtures.js";

const query = (text, extra = {}) => ({ query: text, includeArchived: true, ...extra });

test("only text blocks are searchable", async (t) => {
  const corpus = await makeCorpus();
  t.after(() => cleanup(corpus));
  await writeSession(corpus, "a.jsonl", [
    sessionHeader("s1"),
    textMessage("m1", null, "user", "the rollback plan"),
    contentMessage("m2", "m1", "assistant", [{ type: "thinking", thinking: "zebra reasoning" }]),
    contentMessage("m3", "m2", "assistant", [{ type: "toolCall", name: "bash", arguments: { command: "zebra" } }]),
    contentMessage("m4", "m3", "toolResult", [{ type: "text", text: "zebra output" }]),
    compaction("c1", "m4", "zebra summary"),
  ]);

  const zebra = await scanSessions(corpus, query("zebra"));
  assert.deepEqual(zebra.sessions, []);
  assert.equal(zebra.total, 0);

  const roll = await scanSessions(corpus, query("roll"));
  assert.equal(roll.total, 1);
  assert.equal(roll.sessions[0].hits[0].entryId, "m1");
});

test("ask cards and their answer notes are searchable, tool output is not", async (t) => {
  const corpus = await makeCorpus();
  t.after(() => cleanup(corpus));
  await writeSession(corpus, "a.jsonl", [
    sessionHeader("s1"),
    textMessage("m1", null, "user", "ordinary words"),
    askResult("q1", "m1", {
      ask: {
        askId: "ask-1",
        askedAt: "2026-11-05T21:04:10.037Z",
        questions: [{
          id: "scheduler",
          question: "Which way on the scheduler?",
          detail: "The plugin or the file-native one.",
          options: [
            { value: "build-first", label: "Build the file-native scheduler", detail: "Long option prose about trade-offs." },
            { value: "wait", label: "Not yet" },
          ],
        }],
      },
    }, { content: "Ask_user completed; opaque tool output about wombats." }),
    customMessage("a1", "q1", "The user submitted answers to your questions.\n\n- scheduler: Which way on the scheduler?\n  Answered: selected build-first", "2026-11-05T21:24:28.880Z", { customType: "pi-web.ask.answers" }),
  ]);

  for (const term of ["scheduler", "file-native", "submitted answers", "file-native scheduler"]) {
    const hit = await scanSessions(corpus, { query: term, includeArchived: true });
    assert.ok(hit.total > 0, term);
  }
  // Tool output is not part of the conversation.
  assert.equal((await scanSessions(corpus, query("wombats"))).total, 0);
  // Option detail prose is not indexed; labels are.
  assert.equal((await scanSessions(corpus, query("trade-offs"))).total, 0);

  const card = await scanSessions(corpus, query("Which way"));
  assert.equal(card.sessions[0].hits[0].entryId, "q1");
  assert.equal(card.sessions[0].hits[0].role, "tool");
  const note = await scanSessions(corpus, query("submitted answers"));
  assert.equal(note.sessions[0].hits[0].entryId, "a1");
  assert.equal(note.sessions[0].hits[0].role, "system");
});

test("a hidden custom message and a failed ask are outside the corpus", async (t) => {
  const corpus = await makeCorpus();
  t.after(() => cleanup(corpus));
  await writeSession(corpus, "a.jsonl", [
    sessionHeader("s1"),
    customMessage("h1", null, "hidden quokka note", undefined, { display: false }),
    askResult("f1", "h1", {
      ask: { askId: "a", askedAt: "2026-11-05T21:04:10.037Z", questions: [{ id: "q", question: "failed narwhal question", options: [] }] },
    }, { isError: true }),
  ]);
  assert.equal((await scanSessions(corpus, query("quokka"))).total, 0);
  assert.equal((await scanSessions(corpus, query("narwhal"))).total, 0);
});

test("pre-compaction messages stay searchable", async (t) => {
  const corpus = await makeCorpus();
  t.after(() => cleanup(corpus));
  await writeSession(corpus, "a.jsonl", [
    sessionHeader("s1"),
    textMessage("m1", null, "user", "earlier rollback"),
    compaction("c1", "m1", "summary"),
    textMessage("m2", "c1", "assistant", "later"),
  ]);
  const result = await scanSessions(corpus, query("rollback"));
  assert.equal(result.total, 1);
  assert.equal(result.sessions[0].hits[0].entryId, "m1");
});

test("an abandoned branch is not searchable", async (t) => {
  const corpus = await makeCorpus();
  t.after(() => cleanup(corpus));
  await writeSession(corpus, "a.jsonl", [
    sessionHeader("s1"),
    textMessage("m1", null, "user", "root"),
    textMessage("m2", "m1", "assistant", "abandoned zebra"),
    textMessage("m3", "m1", "user", "kept reply"),
  ]);
  const result = await scanSessions(corpus, query("zebra"));
  assert.equal(result.total, 0);
});

test("a torn final line is end of file, not an error", async (t) => {
  const corpus = await makeCorpus();
  t.after(() => cleanup(corpus));
  const path = await writeSession(corpus, "a.jsonl", [
    sessionHeader("s1"),
    textMessage("m1", null, "user", "rollback found"),
  ]);
  await appendFile(path, '{"type":"message","id":"m2","parentId":"m1","message":{"role":"assistant","content":[{"type":"te');
  const result = await scanSessions(corpus, query("rollback"));
  assert.equal(result.total, 1);
  assert.equal(result.sessions[0].hits[0].entryId, "m1");
});

test("an archived session is marked, and the live copy wins a transient duplicate", async (t) => {
  const corpus = await makeCorpus();
  t.after(() => cleanup(corpus));
  await writeSession(corpus, "a.jsonl", [sessionHeader("s1"), textMessage("m1", null, "user", "rollback")]);
  await writeSession(corpus, "a-archived.jsonl", [sessionHeader("s1"), textMessage("m1", null, "user", "rollback")], { archived: true });
  const all = await scanSessions(corpus, query("rollback"));
  assert.equal(all.sessions.length, 1);
  assert.equal(all.sessions[0].archived, false);

  await writeSession(corpus, "b.jsonl", [sessionHeader("s2"), textMessage("m1", null, "user", "ephemeral needle")], { archived: true });
  const archivedHit = await scanSessions(corpus, query("ephemeral"));
  assert.equal(archivedHit.sessions.length, 1);
  assert.equal(archivedHit.sessions[0].archived, true);
  const excluded = await scanSessions(corpus, query("ephemeral", { includeArchived: false }));
  assert.equal(excluded.sessions.length, 0);
});

test("per-session cap and the time budget are visible, not silent", async (t) => {
  const corpus = await makeCorpus();
  t.after(() => cleanup(corpus));
  const entries = [sessionHeader("s1")];
  let parent = null;
  for (let index = 0; index < 6; index += 1) {
    const id = `m${index}`;
    entries.push(textMessage(id, parent, "user", `rollback ${index}`));
    parent = id;
  }
  await writeSession(corpus, "a.jsonl", entries);

  const capped = await scanSessions(corpus, query("rollback"));
  assert.equal(capped.total, 6);
  assert.equal(capped.sessions[0].hits.length, 3);

  const truncated = await scanSessions(corpus, query("rollback"), { budgetMs: -1 });
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.sessions.length, 0);
});

test("a session with no project is still a hit with its cwd", async (t) => {
  const corpus = await makeCorpus();
  t.after(() => cleanup(corpus));
  await writeSession(corpus, "a.jsonl", [
    sessionHeader("s1", "/workspace"),
    textMessage("m1", null, "user", "rollback"),
  ]);
  const result = await scanSessions(corpus, query("rollback"));
  assert.equal(result.sessions[0].cwd, "/workspace");
});

test("unreadable files do not fail the query", async (t) => {
  const corpus = await makeCorpus();
  t.after(() => cleanup(corpus));
  await writeFile(`${corpus.sessionDir}/--work--/broken.jsonl`, "not json\n", "utf8");
  await writeSession(corpus, "a.jsonl", [sessionHeader("s1"), textMessage("m1", null, "user", "rollback")]);
  const result = await scanSessions(corpus, query("rollback"));
  assert.equal(result.total, 1);
});
