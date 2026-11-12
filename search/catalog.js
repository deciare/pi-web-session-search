import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * What pi-web knows about a session beyond its transcript: the project it
 * belongs to and the folders it was filed in.
 *
 * None of this is in the session file. `projects.json` is pi-web's project
 * registry; `session-folders.json` is the folder tree and its placements, which
 * house patch 0009 adds. Both are optional here: a host without folders, or a
 * fresh install without projects, yields an empty catalog rather than failing
 * the read.
 */
export async function readCatalog(dataDirectory) {
  const [projectsFile, foldersFile] = await Promise.all([
    readJson(join(dataDirectory, "projects.json")),
    readJson(join(dataDirectory, "session-folders.json")),
  ]);
  const folders = new Map();
  for (const folder of asArray(foldersFile?.["folders"])) {
    const id = text(folder?.["id"]);
    const name = text(folder?.["name"]);
    if (id === undefined || name === undefined) continue;
    folders.set(id, { id, name, parentId: text(folder?.["parentId"]) ?? null });
  }
  const placements = new Map();
  const raw = foldersFile?.["placements"];
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [sessionId, ids] of Object.entries(raw)) {
      const existing = asArray(ids).filter((id) => text(id) !== undefined && folders.has(text(id)));
      if (existing.length > 0) placements.set(sessionId, existing.map((id) => String(id)));
    }
  }
  const projects = asArray(projectsFile?.["projects"]).flatMap((project) => {
    const id = text(project?.["id"]);
    const path = text(project?.["path"]);
    if (id === undefined || path === undefined) return [];
    return [{ id, name: text(project?.["name"]) ?? path, path: withoutTrailingSlash(path) }];
  });
  return { projects, folders, placements };
}

/** The project whose path contains `cwd`, preferring the longest match. */
export function projectFor(cwd, projects) {
  if (typeof cwd !== "string" || cwd === "") return undefined;
  const path = withoutTrailingSlash(cwd);
  let best;
  for (const project of projects) {
    if (path !== project.path && !path.startsWith(`${project.path}/`)) continue;
    if (best === undefined || project.path.length > best.path.length) best = project;
  }
  return best;
}

/** The folder and all of its descendants, so a folder filter means the subtree. */
export function folderSubtree(folderId, folders) {
  const ids = new Set();
  if (!folders.has(folderId)) return ids;
  const pending = [folderId];
  while (pending.length > 0) {
    const id = pending.pop();
    if (ids.has(id)) continue;
    ids.add(id);
    for (const folder of folders.values()) {
      if (folder.parentId === id) pending.push(folder.id);
    }
  }
  return ids;
}

/** Folder ids for a session, as `{id, name}` is not needed here. */
export function foldersOf(sessionId, catalog) {
  return catalog.placements.get(sessionId) ?? [];
}

export function folderViews(ids, folders) {
  return ids.flatMap((id) => {
    const folder = folders.get(id);
    return folder === undefined ? [] : [{ id: folder.id, name: folder.name }];
  });
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function withoutTrailingSlash(path) {
  return path.length > 1 ? path.replace(/\/+$/u, "") : path;
}
