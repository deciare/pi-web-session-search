import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readCatalog, folderSubtree, projectFor } from "../search/catalog.js";
import { buildSessionList, parseListInput } from "../search/listing.js";
import { readSummariesFromFiles } from "../search/summaries.js";
import {
  cleanup,
  makeCorpus,
  sessionHeader,
  sessionInfo,
  textMessage,
  writeSession,
} from "./fixtures.js";

const summary = (overrides) => ({
  id: "s1",
  path: "/sessions/s1.jsonl",
  cwd: "/work/alpha",
  name: "A session",
  created: "2026-11-01T00:00:00.000Z",
  mtimeMs: Date.parse("2026-11-10T00:00:00.000Z"),
  archived: false,
  ...overrides,
});

function catalog(overrides = {}) {
  return {
    projects: [
      { id: "p1", name: "Alpha", path: "/work/alpha" },
      { id: "p2", name: "Work", path: "/work" },
    ],
    folders: new Map([
      ["f1", { id: "f1", name: "Work", parentId: null }],
      ["f2", { id: "f2", name: "pi-web", parentId: "f1" }],
      ["f3", { id: "f3", name: "Other", parentId: null }],
    ]),
    placements: new Map([["s1", ["f2"]], ["s2", ["f3"]]]),
    ...overrides,
  };
}

test("list input defaults to unarchived sessions, newest first, thirty at a time", () => {
  assert.deepEqual(parseListInput(undefined), { includeArchived: false, limit: 30, offset: 0 });
  assert.equal(parseListInput({ limit: 500 }).limit, 100);
  assert.equal(parseListInput({ includeArchived: true }).includeArchived, true);
  for (const bad of [{ limit: 0 }, { limit: 1.5 }, { offset: -1 }, { modifiedAfter: "soon" }, { path: 42 }]) {
    assert.throws(() => parseListInput(bad), TypeError, JSON.stringify(bad));
  }
});

test("the project is the longest matching path", () => {
  assert.equal(projectFor("/work/alpha/scoped", catalog().projects).id, "p1");
  assert.equal(projectFor("/work/beta", catalog().projects).id, "p2");
  assert.equal(projectFor("/elsewhere", catalog().projects), undefined);
});

test("a folder filter covers its descendants", () => {
  assert.deepEqual([...folderSubtree("f1", catalog().folders)].sort(), ["f1", "f2"]);
  assert.deepEqual([...folderSubtree("missing", catalog().folders)], []);
});

test("filters are additive and total counts what they matched", () => {
  const summaries = [
    summary({ id: "s1", name: "Scheduler work", mtimeMs: Date.parse("2026-11-10T00:00:00.000Z") }),
    summary({ id: "s2", cwd: "/work/beta", name: "Japanese notes", mtimeMs: Date.parse("2026-11-09T00:00:00.000Z") }),
    summary({ id: "s3", archived: true, name: "Old thing", mtimeMs: Date.parse("2026-11-08T00:00:00.000Z") }),
  ];
  const listed = buildSessionList(summaries, parseListInput({}), catalog());
  assert.deepEqual(listed.sessions.map((session) => session.id), ["s1", "s2"]);
  assert.equal(listed.total, 2);
  assert.equal(listed.truncated, false);
  assert.deepEqual(listed.sessions[0].folders, [{ id: "f2", name: "pi-web" }]);
  assert.equal(listed.sessions[0].project.id, "p1");

  assert.deepEqual(buildSessionList(summaries, parseListInput({ includeArchived: true }), catalog()).sessions.map((session) => session.id), ["s1", "s2", "s3"]);
  assert.deepEqual(buildSessionList(summaries, parseListInput({ folderId: "f1" }), catalog()).sessions.map((session) => session.id), ["s1"]);
  assert.deepEqual(buildSessionList(summaries, parseListInput({ folderId: "f1", includeArchived: true }), catalog()).sessions.map((session) => session.id), ["s1"]);
  assert.deepEqual(buildSessionList(summaries, parseListInput({ projectId: "p2" }), catalog()).sessions.map((session) => session.id), ["s2"]);
  assert.deepEqual(buildSessionList(summaries, parseListInput({ path: "/work/alpha" }), catalog()).sessions.map((session) => session.id), ["s1"]);
  assert.deepEqual(buildSessionList(summaries, parseListInput({ nameContains: "sched" }), catalog()).sessions.map((session) => session.id), ["s1"]);
  assert.deepEqual(
    buildSessionList(summaries, parseListInput({ modifiedAfter: "2026-11-08T12:00:00Z", modifiedBefore: "2026-11-09T12:00:00Z" }), catalog()).sessions.map((session) => session.id),
    ["s2"],
  );
});

test("paging reports what was left behind", () => {
  const summaries = ["a", "b", "c", "d"].map((id, index) => summary({ id, mtimeMs: Date.parse("2026-11-10T00:00:00Z") - index * 1_000 }));
  const first = buildSessionList(summaries, parseListInput({ limit: 2 }), catalog());
  assert.deepEqual(first.sessions.map((session) => session.id), ["a", "b"]);
  assert.equal(first.total, 4);
  assert.equal(first.truncated, true);
  const second = buildSessionList(summaries, parseListInput({ limit: 2, offset: 2 }), catalog());
  assert.deepEqual(second.sessions.map((session) => session.id), ["c", "d"]);
  assert.equal(second.truncated, false);
});

test("a missing projects or folders file is an empty catalog, not a failure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "session-search-catalog-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const empty = await readCatalog(directory);
  assert.deepEqual(empty.projects, []);
  assert.equal(empty.folders.size, 0);
  assert.equal(empty.placements.size, 0);

  await writeFile(join(directory, "projects.json"), JSON.stringify({ projects: [{ id: "p", name: "P", path: "/work/" }] }), "utf8");
  await writeFile(join(directory, "session-folders.json"), JSON.stringify({
    folders: [{ id: "f", parentId: null, name: "Folder" }],
    placements: { s1: ["f"], s2: ["missing"] },
  }), "utf8");
  const catalogued = await readCatalog(directory);
  assert.deepEqual(catalogued.projects, [{ id: "p", name: "P", path: "/work" }]);
  assert.deepEqual(catalogued.placements.get("s1"), ["f"]);
  assert.equal(catalogued.placements.has("s2"), false);
});

test("summaries can be read from the files while the index is cold", async (t) => {
  const corpus = await makeCorpus();
  t.after(() => cleanup(corpus));
  await writeSession(corpus, "a.jsonl", [
    sessionHeader("s1", "/work/alpha"),
    textMessage("m1", null, "user", "hello"),
    sessionInfo("i1", "m1", "Renamed later"),
  ]);
  const summaries = await readSummariesFromFiles(corpus);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].id, "s1");
  assert.equal(summaries[0].name, "Renamed later");
  assert.equal(summaries[0].cwd, "/work/alpha");
  assert.equal(summaries[0].created, "2026-01-01T00:00:00.000Z");
});
