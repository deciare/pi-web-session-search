import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSettingsStore, normalizeTimeFormat, SETTINGS_FILE } from "../search/settings.js";

async function store(t) {
  const directory = await mkdtemp(join(tmpdir(), "session-search-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const warnings = [];
  return {
    directory,
    warnings,
    path: join(directory, SETTINGS_FILE),
    settings: createSettingsStore({ dataDirectory: directory, logger: { warn: (message) => warnings.push(message) } }),
  };
}

test("a missing settings file means relative time", async (t) => {
  const { settings, path } = await store(t);
  assert.deepEqual(await settings.read(), { timeFormat: "relative", includeArchived: true });
  assert.equal(settings.path, path);
});

test("a stored pattern is read, trimmed, and blank means relative", async (t) => {
  const { settings, path } = await store(t);
  await writeFile(path, JSON.stringify({ timeFormat: "  %Y-%m-%d %H:%M:%S  " }), "utf8");
  assert.deepEqual(await settings.read(), { timeFormat: "%Y-%m-%d %H:%M:%S", includeArchived: true });
  await writeFile(path, JSON.stringify({ timeFormat: "   " }), "utf8");
  assert.deepEqual(await settings.read(), { timeFormat: "relative", includeArchived: true });
});

test("an unreadable file falls back to defaults and says so once per read", async (t) => {
  const { settings, path, warnings } = await store(t);
  await writeFile(path, "{ not json", "utf8");
  assert.deepEqual(await settings.read(), { timeFormat: "relative", includeArchived: true });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /settings\.json/u);
});

test("a hand edit is noticed without restarting anything", async (t) => {
  const { settings, path } = await store(t);
  assert.deepEqual(await settings.read(), { timeFormat: "relative", includeArchived: true });
  await writeFile(path, JSON.stringify({ timeFormat: "%H:%M", includeArchived: false }), "utf8");
  assert.deepEqual(await settings.read(), { timeFormat: "%H:%M", includeArchived: false });
  await writeFile(path, JSON.stringify({ timeFormat: "%Y-%m-%d" }), "utf8");
  assert.deepEqual(await settings.read(), { timeFormat: "%Y-%m-%d", includeArchived: true });
});

test("writing preserves other keys and leaves no temporary file", async (t) => {
  const { settings, path, directory } = await store(t);
  await writeFile(path, JSON.stringify({ timeFormat: "relative", includeArchived: false, future: { keep: true } }), "utf8");
  assert.deepEqual(await settings.write({ timeFormat: "%F %T" }), { timeFormat: "%F %T", includeArchived: false });
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(saved, { timeFormat: "%F %T", includeArchived: false, future: { keep: true } });
  await assert.rejects(stat(`${path}.tmp`));
  assert.deepEqual(await settings.read(), { timeFormat: "%F %T", includeArchived: false });

  // A patch touches only the field it names.
  assert.deepEqual(await settings.write({ includeArchived: true }), { timeFormat: "%F %T", includeArchived: true });
  assert.deepEqual(await settings.write({ timeFormat: "" }), { timeFormat: "relative", includeArchived: true });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).future, { keep: true });
  assert.ok(directory.length > 0);
});

test("the archived flag defaults to included and accepts only booleans", async (t) => {
  const { settings, path } = await store(t);
  assert.equal((await settings.read()).includeArchived, true);
  await writeFile(path, JSON.stringify({ includeArchived: "yes" }), "utf8");
  assert.equal((await settings.read()).includeArchived, true);
  assert.equal((await settings.write({ includeArchived: false })).includeArchived, false);
  assert.equal((await settings.read()).includeArchived, false);
});

test("the stored value is normalised the same way the panel normalises it", () => {
  for (const [input, expected] of [
    ["%Y", "%Y"], ["  %Y  ", "%Y"], ["", "relative"], ["   ", "relative"],
    [undefined, "relative"], [null, "relative"], [42, "relative"], [{}, "relative"],
  ]) {
    assert.equal(normalizeTimeFormat(input), expected, String(input));
  }
});
