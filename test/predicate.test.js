import assert from "node:assert/strict";
import test from "node:test";
import { messageText } from "../search/predicate.js";
import { activeBranch, entryLink, lineMayMatch } from "../search/session-file.js";
import { matchSnippet } from "../search/snippets.js";

test("message text is structural: text blocks only, never thinking or tool calls", () => {
  assert.equal(messageText({ role: "system", content: "preamble" }), undefined);
  assert.equal(messageText({ role: "toolResult", content: "output" }), undefined);
  assert.equal(messageText({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "secret reasoning" },
      { type: "text", text: "visible answer" },
      { type: "toolCall", name: "bash", arguments: { command: "echo secret" } },
    ],
  }), "visible answer");
  assert.equal(messageText({ role: "assistant", content: [{ type: "thinking", thinking: "secret" }] }), undefined);
  assert.equal(messageText({ role: "user", content: [] }), undefined);
  assert.equal(messageText({ role: "user", content: "plain string" }), "plain string");
});

test("multiple text blocks join in display order", () => {
  assert.equal(messageText({
    role: "assistant",
    content: [{ type: "text", text: "first" }, { type: "text", text: "second" }],
  }), "first\n\nsecond");
});

test("the active branch is the parent walk from the last entry", () => {
  const entries = [
    { id: "a", parentId: null },
    { id: "b", parentId: "a" },
    { id: "c", parentId: "b" },
    { id: "d", parentId: "b" },
  ];
  const branch = activeBranch(entries);
  assert.deepEqual([...branch].sort(), ["a", "b", "d"]);
  assert.equal(branch.has("c"), false);
});

test("entry links come from the cheap path and fall back to JSON", () => {
  assert.deepEqual(entryLink('{"type":"message","id":"m1","parentId":"m0","timestamp":"t","message":{}}'),
    { type: "message", id: "m1", parentId: "m0" });
  assert.deepEqual(entryLink('{"type":"message","id":"m1","parentId":null,"message":{}}'),
    { type: "message", id: "m1", parentId: null });
  assert.deepEqual(entryLink('{"type":"custom","customType":"x","data":{},"id":"c1","parentId":"m1"}'),
    { type: "custom", id: "c1", parentId: "m1" });
  assert.equal(entryLink('{"type":"session","version":3,"id":"s"}'), undefined);
});

test("the raw-line prefilter is safe for plain ASCII and refuses escaped characters", () => {
  const line = JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: [{ type: "text", text: "Rollback the plan" }] } });
  assert.equal(lineMayMatch(line, "roll"), true);
  assert.equal(lineMayMatch(line, "absent"), false);
  // A query carrying a quote or backslash cannot be prefiltered: JSON escapes
  // it, so the raw bytes differ from the text.
  const quoted = JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: [{ type: "text", text: 'say "roll" now' }] } });
  assert.equal(lineMayMatch(quoted, undefined), true);
});

test("a multi-block message is parsed even when the prefilter misses", () => {
  const line = JSON.stringify({
    type: "message", id: "m1", parentId: null,
    message: { role: "assistant", content: [{ type: "text", text: "alpha" }, { type: "text", text: "beta" }] },
  });
  assert.equal(lineMayMatch(line, "alphabeta"), true);
});

test("snippet offsets mark the match in the original text", () => {
  const text = `${"x".repeat(200)} rollback and resolvePluginNavigation`;
  const { snippet, matchStart, matchLength } = matchSnippet(text, "roll");
  assert.equal(matchStart, 201);
  assert.equal(matchLength, 4);
  assert.match(snippet, /rollback/u);
  assert.equal(matchSnippet(text, "absent").matchLength, 0);
});
