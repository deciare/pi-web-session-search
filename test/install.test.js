import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const packageName = JSON.parse(await readFile(join(root, "package.json"), "utf8")).name;

function install(argument) {
  try {
    const stdout = execFileSync(process.execPath, [join(root, "scripts/install.js"), argument], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout, stderr: "" };
  } catch (error) {
    return { ok: false, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
  }
}

async function pluginsDirectory(t) {
  const parent = await mkdtemp(join(tmpdir(), "session-search-install-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const plugins = join(parent, "plugins");
  await mkdir(plugins);
  return { parent, plugins };
}

test("installs into an empty plugins directory", async (t) => {
  const { plugins } = await pluginsDirectory(t);
  const result = install(plugins);
  assert.equal(result.ok, true, result.stderr);
  const installed = join(plugins, "session-search");
  assert.equal(JSON.parse(await readFile(join(installed, "package.json"), "utf8")).name, packageName);
  assert.deepEqual((await readdir(plugins)).sort(), ["session-search"]);
});

test("replaces a previous install whole, dropping files it no longer ships", async (t) => {
  const { plugins } = await pluginsDirectory(t);
  assert.equal(install(plugins).ok, true);
  await writeFile(join(plugins, "session-search", "stale.js"), "old\n", "utf8");
  const result = install(plugins);
  assert.equal(result.ok, true, result.stderr);
  assert.deepEqual((await readdir(plugins)).sort(), ["session-search"]);
  assert.equal((await readdir(join(plugins, "session-search"))).includes("stale.js"), false);
});

test("refuses a non-empty directory that is not an install of this plugin", async (t) => {
  const { plugins } = await pluginsDirectory(t);
  const foreign = join(plugins, "session-search");
  await mkdir(foreign);
  await writeFile(join(foreign, "keep.txt"), "someone else's files\n", "utf8");
  const result = install(plugins);
  assert.equal(result.ok, false);
  assert.match(result.stderr, /not an install/u);
  assert.equal(await readFile(join(foreign, "keep.txt"), "utf8"), "someone else's files\n");
});

test("refuses a destination that is a symlink", async (t) => {
  const { parent, plugins } = await pluginsDirectory(t);
  const elsewhere = join(parent, "elsewhere");
  await mkdir(elsewhere);
  await symlink(elsewhere, join(plugins, "session-search"));
  const result = install(plugins);
  assert.equal(result.ok, false);
  assert.match(result.stderr, /symlink/u);
});

test("refuses the data directory that contains the plugins directory", async (t) => {
  const { parent } = await pluginsDirectory(t);
  const result = install(parent);
  assert.equal(result.ok, false);
  assert.match(result.stderr, /data directory/u);
});

test("refuses an install copy passed as the plugins directory", async (t) => {
  const { plugins } = await pluginsDirectory(t);
  assert.equal(install(plugins).ok, true);
  const result = install(join(plugins, "session-search"));
  assert.equal(result.ok, false);
  assert.match(result.stderr, /not the plugins directory/u);
});

test("refuses a plugins directory that does not exist", async (t) => {
  const { parent } = await pluginsDirectory(t);
  const result = install(join(parent, "missing"));
  assert.equal(result.ok, false);
  assert.match(result.stderr, /does not exist/u);
});

test("refuses to install over the source tree", async (t) => {
  const result = install(root);
  assert.equal(result.ok, false);
  assert.match(result.stderr, /source tree/u);
});

test("leftovers from an interrupted install do not break the next one", async (t) => {
  const { plugins } = await pluginsDirectory(t);
  assert.equal(install(plugins).ok, true);
  await mkdir(join(plugins, ".session-search.incoming"));
  await writeFile(join(plugins, ".session-search.incoming", "junk"), "x\n", "utf8");
  const result = install(plugins);
  assert.equal(result.ok, true, result.stderr);
  assert.deepEqual((await readdir(plugins)).sort(), ["session-search"]);
});
