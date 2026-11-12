import assert from "node:assert/strict";
import test from "node:test";
import { buildHistory, buildTurns, parseHistoryInput, readTranscript } from "../search/transcript.js";
import { activeBranch } from "../search/session-file.js";
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

const T = (minute) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
const ASK = {
  ask: {
    askId: "ask-1",
    askedAt: T(2),
    questions: [{
      id: "q1",
      question: "Which way on the scheduler?",
      detail: "The plugin or the file-native one.",
      options: [
        { value: "build-first", label: "Build the file-native scheduler", detail: "Trade-offs." },
        { value: "wait", label: "Not yet" },
      ],
    }],
  },
};
const ANSWERS = {
  askId: "ask-1",
  questions: [{
    question: { id: "q1", question: "Which way on the scheduler?", options: ASK.ask.questions[0].options },
    values: ["build-first"],
  }],
};

async function transcript(t) {
  const corpus = await makeCorpus();
  t.after(() => cleanup(corpus));
  const path = await writeSession(corpus, "a.jsonl", [
    sessionHeader("s1", "/work/alpha"),
    textMessage("m1", null, "user", "first question", T(0)),
    contentMessage("m2", "m1", "assistant", [
      { type: "text", text: "answer one" },
      { type: "thinking", thinking: "hidden reasoning" },
    ], T(1)),
    contentMessage("m3", "m2", "toolResult", [{ type: "text", text: "file.txt" }], T(1)),
    askResult("q1", "m3", ASK, { content: "asked", timestamp: T(2) }),
    customMessage("a1", "q1", "The user submitted answers to your questions.", T(3), { customType: "pi-web.ask.answers", details: ANSWERS }),
    // A branch that starts at m1 and is then abandoned by m4.
    textMessage("m6", "m1", "assistant", "abandoned branch", T(7)),
    textMessage("m4", "a1", "user", "second question", T(4)),
    textMessage("m5", "m4", "assistant", "answer two", T(5)),
    compaction("c1", "m5", "Earlier conversation, summarised.", T(6)),
  ]);
  const read = await readTranscript(path);
  return { corpus, path, read };
}

function history(read, input) {
  return buildHistory({ transcript: read, session: { id: "s1" }, input: parseHistoryInput({ sessionId: "s1", ...input }) });
}

test("the transcript keeps every entry, including the abandoned one", async (t) => {
  const { read } = await transcript(t);
  assert.equal(read.entries.length, 9);
  assert.equal(read.header.id, "s1");
  assert.equal(read.entries.some((entry) => entry.id === "m6"), true);
});

test("a turn starts at a user message and ask notes do not start one", async (t) => {
  const { read } = await transcript(t);
  const branch = activeBranch(read.entries.map((entry) => ({ id: entry.id, parentId: entry.parentId })));
  const turns = buildTurns(read.entries.filter((entry) => branch.has(entry.id)));
  assert.deepEqual(turns.map((turn) => turn.userEntryId), ["m1", "m4"]);
  assert.deepEqual(turns[0].entries.map((entry) => entry.id), ["m1", "m2", "m3", "q1", "a1"]);
  assert.deepEqual(turns[1].entries.map((entry) => entry.id), ["m4", "m5", "c1"]);
});

test("the default is the last turn, conversation only", async (t) => {
  const { read } = await transcript(t);
  const result = history(read, {});
  assert.deepEqual(result.entries.map((entry) => entry.kind), ["text", "text"]);
  assert.deepEqual(result.entries.map((entry) => entry.text), ["second question", "answer two"]);
  assert.equal(result.entries[0].turnIndex, 1);
  assert.equal(result.truncated, false);
});

test("everything adds thinking, tool output and compaction", async (t) => {
  const { read } = await transcript(t);
  const result = history(read, { lastTurns: 1, everything: true });
  assert.deepEqual(result.entries.map((entry) => entry.kind), ["text", "text", "compaction"]);
  const first = history(read, { entryId: "m2", contextTurnsBefore: 0, contextTurnsAfter: 0, everything: true });
  assert.deepEqual(first.entries.map((entry) => entry.kind), ["text", "text", "thinking", "toolResult", "ask", "note"]);
  assert.equal(first.entries[2].text, "hidden reasoning");
  assert.equal(first.entries[3].tool.output, "file.txt");
});

test("an ask entry carries its questions, options and the chosen label", async (t) => {
  const { read } = await transcript(t);
  const result = history(read, { entryId: "q1", contextTurnsBefore: 0, contextTurnsAfter: 0 });
  const ask = result.entries.find((entry) => entry.kind === "ask");
  assert.equal(ask.role, "tool");
  assert.equal(ask.ask.askId, "ask-1");
  assert.equal(ask.ask.questions[0].question, "Which way on the scheduler?");
  assert.deepEqual(ask.ask.questions[0].options, ["Build the file-native scheduler", "Not yet"]);
  assert.deepEqual(ask.ask.questions[0].chosen, ["Build the file-native scheduler"]);
});

test("an anchor takes asymmetric context turns", async (t) => {
  const { read } = await transcript(t);
  const alone = history(read, { entryId: "m4", contextTurnsBefore: 0, contextTurnsAfter: 0 });
  // The anchored turn is returned whole, however many context turns are asked for.
  assert.deepEqual(alone.entries.map((entry) => entry.text), ["second question", "answer two"]);
  const withBefore = history(read, { entryId: "m4", contextTurnsBefore: 1, contextTurnsAfter: 0 });
  assert.equal(withBefore.entries.some((entry) => entry.text === "first question"), true);
  assert.equal(withBefore.entries.some((entry) => entry.text === "answer two"), true);
});

test("a time range selects entries, not turns", async (t) => {
  const { read } = await transcript(t);
  const result = history(read, { since: T(1), until: T(2) });
  assert.deepEqual(result.entries.map((entry) => entry.entryId), ["m2", "q1"]);
  assert.equal(result.entries.every((entry) => entry.turnIndex === 0), true);
});

test("an entry on an abandoned branch is an error, not an empty list", async (t) => {
  const { read } = await transcript(t);
  assert.throws(() => history(read, { entryId: "m6" }), /not on this session's active branch/u);
});

test("the budget keeps whole entries and reports what it omitted", async (t) => {
  const { read } = await transcript(t);
  const result = buildHistory({
    transcript: read,
    session: { id: "s1" },
    input: parseHistoryInput({ sessionId: "s1", lastTurns: 1 }),
    budget: 130,
  });
  assert.equal(result.truncated, true);
  assert.equal(result.entries.length, 1);
  assert.equal(result.omitted, 1);
  assert.equal(JSON.stringify(result.entries[0]).length <= 130, true);
});

test("input validation names the conflicting or missing piece", () => {
  assert.throws(() => parseHistoryInput({}), /sessionId/u);
  assert.throws(() => parseHistoryInput({ sessionId: "s", entryId: "e", lastTurns: 2 }), /one of/u);
  assert.throws(() => parseHistoryInput({ sessionId: "s", contextTurnsBefore: 2 }), /require entryId/u);
  assert.throws(() => parseHistoryInput({ sessionId: "s", since: T(2), until: T(1) }), /after/u);
  assert.deepEqual(parseHistoryInput({ sessionId: "s" }), {
    sessionId: "s", contextTurnsBefore: 1, contextTurnsAfter: 1, lastTurns: 1, everything: false,
  });
});
