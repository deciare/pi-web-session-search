/**
 * Install this package into a PI WEB plugins directory.
 *
 *   node scripts/install.js /data/pi-web/plugins
 *
 * The argument is the *plugins directory*, not this plugin's directory inside
 * it: the destination is always `<plugins>/session-search`. The source tree is
 * canonical and the installed copy is output, so this replaces the destination
 * whole — but only after proving that the destination is empty or is a previous
 * install of this same plugin. It never deletes a directory it cannot identify,
 * and a failed copy leaves the previous install in place.
 */
import { cp, lstat, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const packageName = manifest.name;
const pluginId = manifest.piWeb?.plugins?.[0]?.id;
if (typeof packageName !== "string" || typeof pluginId !== "string") {
  fail("the source package.json does not declare piWeb.plugins[0].id");
}

const argument = process.argv[2];
if (argument === undefined) {
  usage();
  process.exit(2);
}

const pluginsDirectory = resolve(argument);
const destination = join(pluginsDirectory, pluginId);

// ---- the argument must be a plugins directory, and nothing else -------------

if (pluginsDirectory === root) fail("that is the source tree, not a plugins directory");
if (pluginsDirectory.startsWith(`${root}/`)) fail("refusing to install inside the source tree");
if (await isFile(pluginsDirectory)) fail(`${pluginsDirectory} is a file, not a directory`);
if (await isOurs(pluginsDirectory)) {
  fail(`${pluginsDirectory} is a copy of this plugin, not the plugins directory that contains it`);
}
if (!(await isDirectory(pluginsDirectory))) {
  fail(`${pluginsDirectory} does not exist; pass the plugins directory that contains session-search`);
}
if (basename(pluginsDirectory) === pluginId) {
  fail(`${pluginsDirectory} is already named ${pluginId}; pass its parent directory instead`);
}
if (await isDirectory(join(pluginsDirectory, "plugins"))) {
  fail(`${pluginsDirectory} looks like the PI WEB data directory; pass its "plugins" subdirectory`);
}

// ---- the destination must be absent, empty, or a previous install of ours ---

const existing = await lstatOrUndefined(destination);
if (existing !== undefined) {
  if (existing.isSymbolicLink()) {
    fail(`${destination} is a symlink; replace it deliberately, then run this again`);
  }
  if (!existing.isDirectory()) fail(`${destination} exists and is not a directory`);
  const entries = await readdir(destination);
  if (entries.length > 0 && !(await isOurs(destination))) {
    fail(`${destination} is not empty and is not an install of ${packageName}; refusing to delete it`);
  }
}

// ---- stage, then swap: a failed copy leaves the previous install intact -----

const staging = join(pluginsDirectory, `.${pluginId}.incoming`);
const previous = join(pluginsDirectory, `.${pluginId}.previous`);
await rm(staging, { recursive: true, force: true });
try {
  await cp(root, staging, {
    recursive: true,
    filter: (source) => {
      const name = basename(source);
      return name !== ".git" && name !== "node_modules";
    },
  });
  await rm(previous, { recursive: true, force: true });
  if (existing !== undefined) await rename(destination, previous);
  await rename(staging, destination);
  await rm(previous, { recursive: true, force: true });
} catch (error) {
  // Put the old copy back if the swap got as far as moving it aside.
  await rm(staging, { recursive: true, force: true }).catch(() => {});
  if (await isDirectory(previous)) await rename(previous, destination).catch(() => {});
  fail(`install failed: ${error instanceof Error ? error.message : String(error)}`);
}

console.log(`installed ${packageName} to ${destination}`);
console.log("restart the session daemon, then reload the browser page");

async function isOurs(directory) {
  try {
    const candidate = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    return candidate.name === packageName
      && Array.isArray(candidate.piWeb?.plugins)
      && candidate.piWeb.plugins.some((plugin) => plugin?.id === pluginId);
  } catch {
    return false;
  }
}

async function isDirectory(path) {
  const info = await stat(path).catch(() => undefined);
  return info?.isDirectory() === true;
}

async function isFile(path) {
  const info = await stat(path).catch(() => undefined);
  return info?.isFile() === true;
}

async function lstatOrUndefined(path) {
  return await lstat(path).catch(() => undefined);
}

function usage() {
  console.error("usage: node scripts/install.js <plugins-directory>");
  console.error(`       installs to <plugins-directory>/${pluginId}`);
  console.error(`       source: ${root}`);
}

function fail(message) {
  console.error(`install: ${message}`);
  process.exit(1);
}
