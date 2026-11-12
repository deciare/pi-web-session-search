import { folderSubtree, folderViews, foldersOf, projectFor } from "./catalog.js";

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

/** Validate one `list` request. Throws TypeError, which the peer reports as a failed call. */
export function parseListInput(value) {
  if (value === undefined || value === null) return defaults();
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("list input must be an object");
  return {
    projectId: optionalString(value, "projectId"),
    path: optionalPath(value, "path"),
    folderId: optionalString(value, "folderId"),
    nameContains: optionalString(value, "nameContains"),
    includeArchived: value.includeArchived === true,
    modifiedAfter: optionalInstant(value, "modifiedAfter"),
    modifiedBefore: optionalInstant(value, "modifiedBefore"),
    limit: optionalLimit(value.limit),
    offset: optionalOffset(value.offset),
  };
}

function defaults() {
  return { includeArchived: false, limit: DEFAULT_LIMIT, offset: 0 };
}

/**
 * Filter, order and page the summaries. Ordering is newest first, the same
 * recency rule as search; `total` counts everything the filters matched, so a
 * page can be told apart from the whole answer.
 */
export function buildSessionList(summaries, input, catalog) {
  const folderIds = input.folderId === undefined ? undefined : folderSubtree(input.folderId, catalog.folders);
  const nameContains = input.nameContains?.toLowerCase();
  const filtered = summaries.filter((summary) => {
    if (!input.includeArchived && summary.archived) return false;
    if (input.projectId !== undefined && projectFor(summary.cwd, catalog.projects)?.id !== input.projectId) return false;
    if (input.path !== undefined && !withinPath(summary.cwd, input.path)) return false;
    if (folderIds !== undefined && !foldersOf(summary.id, catalog).some((id) => folderIds.has(id))) return false;
    if (nameContains !== undefined && !(summary.name ?? "").toLowerCase().includes(nameContains)) return false;
    if (input.modifiedAfter !== undefined && summary.mtimeMs < input.modifiedAfter) return false;
    if (input.modifiedBefore !== undefined && summary.mtimeMs > input.modifiedBefore) return false;
    return true;
  });
  filtered.sort((left, right) => right.mtimeMs - left.mtimeMs || left.id.localeCompare(right.id));
  const page = filtered.slice(input.offset, input.offset + input.limit);
  return {
    sessions: page.map((summary) => viewSummary(summary, catalog)),
    total: filtered.length,
    truncated: input.offset + page.length < filtered.length,
  };
}

function viewSummary(summary, catalog) {
  const project = projectFor(summary.cwd, catalog.projects);
  return {
    id: summary.id,
    ...(summary.name === undefined ? {} : { name: summary.name }),
    ...(summary.cwd === undefined ? {} : { cwd: summary.cwd }),
    ...(summary.created === undefined ? {} : { created: summary.created }),
    modified: new Date(summary.mtimeMs).toISOString(),
    archived: summary.archived === true,
    ...(project === undefined ? {} : { project: { id: project.id, name: project.name } }),
    folders: folderViews(foldersOf(summary.id, catalog), catalog.folders),
  };
}

function withinPath(cwd, path) {
  if (typeof cwd !== "string" || cwd === "") return false;
  return cwd === path || cwd.startsWith(`${path}/`);
}

function optionalString(value, key) {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "string" || field === "") throw new TypeError(`list.${key} must be a non-empty string`);
  return field;
}

function optionalPath(value, key) {
  const path = optionalString(value, key);
  return path === undefined ? undefined : path.replace(/\/+$/u, "") || "/";
}

function optionalInstant(value, key) {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "string" || field === "") throw new TypeError(`list.${key} must be an ISO timestamp`);
  const instant = Date.parse(field);
  if (!Number.isFinite(instant)) throw new TypeError(`list.${key} must be an ISO timestamp`);
  return instant;
}

function optionalLimit(value) {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1) throw new TypeError("list.limit must be a positive integer");
  return Math.min(value, MAX_LIMIT);
}

function optionalOffset(value) {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0) throw new TypeError("list.offset must be a non-negative integer");
  return value;
}
