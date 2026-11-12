import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Where the transcripts live. The session daemon canonicalizes
 * `PI_CODING_AGENT_DIR` (and the session-dir override, when configured) into the
 * environment before any plugin starts, so reading the environment here observes
 * the same locations pi itself uses. This is the one place the plugin reaches
 * outside its declared surface; a missing directory is reported as a notice.
 */
export function resolveCorpus(env = process.env, home = homedir()) {
  const agentDir = resolve(nonEmpty(env.PI_CODING_AGENT_DIR) ?? join(home, ".pi", "agent"));
  const sessionDir = resolve(
    nonEmpty(env.PI_WEB_AGENT_SESSION_DIR)
      ?? nonEmpty(env.PI_CODING_AGENT_SESSION_DIR)
      ?? join(agentDir, "sessions"),
  );
  const dataDir = resolve(nonEmpty(env.PI_WEB_DATA_DIR) ?? join(home, ".pi-web"));
  const archiveDir = resolve(nonEmpty(env.PI_WEB_SESSION_ARCHIVE_DIR) ?? join(dataDir, "archived-sessions"));
  return Object.freeze({ agentDir, sessionDir, archiveDir, dataDir });
}

/**
 * Every transcript file this machine can search, live copies before archived
 * ones, each group newest first. Filesystem failures are not fatal: a directory
 * that does not exist yet is simply empty.
 */
export async function listCandidates(corpus, { includeArchived = true } = {}) {
  const live = await collectLive(corpus.sessionDir);
  const archived = includeArchived ? await collectArchived(corpus.archiveDir) : [];
  live.sort(byModifiedDesc);
  archived.sort(byModifiedDesc);
  return [...live, ...archived];
}

async function collectLive(sessionDir) {
  const files = [];
  const entries = await readDirectory(sessionDir);
  for (const entry of entries) {
    if (entry.isDirectory()) {
      for (const child of await readDirectory(join(sessionDir, entry.name))) {
        if (child.isFile()) await pushCandidate(files, join(sessionDir, entry.name, child.name), false);
      }
    } else if (entry.isFile()) {
      // A session directory can also be configured flat.
      await pushCandidate(files, join(sessionDir, entry.name), false);
    }
  }
  return files;
}

async function collectArchived(archiveDir) {
  const files = [];
  for (const entry of await readDirectory(archiveDir)) {
    if (entry.isFile()) await pushCandidate(files, join(archiveDir, entry.name), true);
  }
  return files;
}

async function pushCandidate(files, path, archived) {
  if (!path.endsWith(".jsonl")) return;
  const info = await stat(path).catch(() => undefined);
  if (info === undefined || !info.isFile()) return;
  files.push({ path, size: info.size, mtimeMs: Math.trunc(info.mtimeMs), archived });
}

async function readDirectory(path) {
  return await readdir(path, { withFileTypes: true }).catch(() => []);
}

function byModifiedDesc(left, right) {
  return right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path);
}

function nonEmpty(value) {
  return value === undefined || value === "" ? undefined : value;
}
