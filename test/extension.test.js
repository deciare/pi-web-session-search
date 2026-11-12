import assert from "node:assert/strict";
import test from "node:test";
import sessionToolsExtension from "../extensions/index.js";
import { companionBackend } from "../extensions/companion.js";
import { createSessionTools } from "../extensions/tools.js";

function fakeHost({ accept = true, failure } = {}) {
  const calls = [];
  const backend = {
    forScope(scope) {
      calls.push({ scope });
      return {
        request: async (operation, input, options) => {
          calls.push({ operation, input, options });
          return { ok: true, operation, input };
        },
      };
    },
  };
  const events = {
    channels: [],
    emit(channel, data) {
      this.channels.push(channel);
      if (!accept) return;
      data.accept(() => {
        if (failure !== undefined) throw failure;
        return backend;
      });
    },
  };
  const tools = [];
  const pi = { events, registerTool: (tool) => tools.push(tool) };
  return { pi, tools, calls, backend, events };
}

test("the extension registers the three session tools once", () => {
  const { pi, tools } = fakeHost();
  sessionToolsExtension(pi);
  assert.deepEqual(tools.map((tool) => tool.name), ["sessions_search", "sessions_list", "sessions_history"]);
  for (const tool of tools) {
    assert.equal(tool.exposure, "deferred");
    assert.equal(tool.namespace.name, "sessions");
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(typeof tool.parameters, "object");
    assert.equal(typeof tool.execute, "function");
  }
  assert.match(tools[2].parameters.required.join(","), /sessionId/u);
});

test("a tool forwards its operation and input through the machine scope", async () => {
  const { pi, tools, calls, events } = fakeHost();
  sessionToolsExtension(pi);
  const search = tools.find((tool) => tool.name === "sessions_search");
  const result = await search.execute("call-1", { query: "rollback" }, undefined);
  assert.equal(events.channels[0], "pi-web:companion-backend:discover");
  assert.deepEqual(calls[0], { scope: { kind: "machine" } });
  assert.equal(calls[1].operation, "search");
  assert.deepEqual(calls[1].input, { query: "rollback" });
  assert.deepEqual(calls[1].options, {});
  assert.deepEqual(result.details, { ok: true, operation: "search", input: { query: "rollback" } });
  assert.equal(result.content[0].type, "text");
  assert.deepEqual(JSON.parse(result.content[0].text), result.details);
});

test("the abort signal is passed through when there is one", async () => {
  const { pi, tools, calls } = fakeHost();
  sessionToolsExtension(pi);
  const controller = new AbortController();
  await tools[0].execute("call-1", { query: "x" }, controller.signal);
  assert.equal(calls[1].options.signal, controller.signal);
});

test("discovery failures surface as tool errors, not silent empties", async () => {
  const missing = fakeHost({ accept: false });
  sessionToolsExtension(missing.pi);
  await assert.rejects(() => missing.tools[0].execute("call-1", { query: "x" }, undefined), /hosted PI WEB event bus/u);

  const broken = fakeHost({ failure: new Error("backend unavailable") });
  sessionToolsExtension(broken.pi);
  await assert.rejects(() => broken.tools[0].execute("call-1", { query: "x" }, undefined), /backend unavailable/u);
});

test("the vendored discovery asks for this plugin and returns the host's backend", () => {
  const backend = { forScope: () => ({ request: async () => null }) };
  const events = {
    emit(channel, data) {
      assert.equal(channel, "pi-web:companion-backend:discover");
      assert.equal(data.pluginId, "session-search");
      data.accept(() => backend);
    },
  };
  assert.equal(companionBackend(events, "session-search"), backend);
});

test("a backend without request support is an explicit error", async () => {
  const backend = { forScope: () => ({}) };
  const tools = createSessionTools({ resolveBackend: () => backend });
  await assert.rejects(() => tools[0].execute("call-1", { query: "x" }, undefined), /does not support search requests/u);
});
