import assert from "node:assert/strict";
import test from "node:test";
import { OPERATIONS, OPERATION_NAME, OPERATION_NAME_MAX_LENGTH } from "../browser/operations.js";
import * as server from "../server-plugin.js";

test("every peer operation satisfies the host's transport rule", () => {
  for (const name of OPERATIONS) {
    assert.match(name, OPERATION_NAME, name);
    assert.ok(name.length <= OPERATION_NAME_MAX_LENGTH, name);
    assert.equal(name, name.toLowerCase(), name);
  }
});

test("operation names are unique", () => {
  assert.equal(new Set(OPERATIONS).size, OPERATIONS.length);
});

test("the server handles exactly the published list", () => {
  const published = new Set(OPERATIONS);
  for (const constant of [
    server.SEARCH_OPERATION,
    server.REBUILD_INDEX_OPERATION,
    server.INDEX_STATUS_OPERATION,
    server.CONFIG_OPERATION,
    server.SET_CONFIG_OPERATION,
  ]) {
    assert.ok(published.has(constant), constant);
  }
  assert.equal(published.size, 5);
});

test("the host's rule is the one the error message quotes", () => {
  assert.equal(String(OPERATION_NAME), String(/^[a-z][a-z0-9.-]*$/u));
});
