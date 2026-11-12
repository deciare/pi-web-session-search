import {
  HISTORY_OPERATION,
  LIST_OPERATION,
  SEARCH_OPERATION,
} from "../browser/operations.js";
import { requestBackend } from "./companion.js";

const NAMESPACE = {
  name: "sessions",
  description: "Read this machine's past conversations: search their text, list them, and read a transcript.",
  instructions: [
    "sessions_search finds text and returns each hit's sessionId and entryId; sessions_history reads the surrounding turn by that entryId.",
    "sessions_list is for finding a conversation by name, project, folder or age rather than by words inside it.",
    "Ids from either tool can be passed to send_session_message and to the session tools that act on a session.",
    "Archived sessions are excluded by default; pass includeArchived when old or deliberately set-aside work is what you want.",
    "sessions_history returns conversation text by default. everything: true adds thinking, tool calls, tool output and compaction summaries, and a long one can exhaust the response budget: narrow the selector if that happens.",
  ].join(" "),
};

const string = (description, maxLength = 512) => ({ type: "string", minLength: 1, maxLength, description });
const count = (description, minimum, maximum) => ({ type: "integer", minimum, maximum, description });

const searchParameters = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: string("Text to find. Substring matching, case-insensitive; three or more characters uses the index.", 500),
    limit: count("Maximum hits to return. Default 20, maximum 100.", 1, 100),
    includeArchived: { type: "boolean", description: "Include archived sessions. Default false." },
    cursor: string("Opaque cursor from a previous result's nextCursor."),
  },
};

const listParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    projectId: string("Registered project id; matches sessions whose working directory is under that project."),
    path: string("Absolute directory prefix of the session working directory."),
    folderId: string("Folder id; matches that folder and its descendants."),
    nameContains: string("Case-insensitive substring of the session name.", 200),
    includeArchived: { type: "boolean", description: "Include archived sessions. Default false." },
    modifiedAfter: string("ISO timestamp; sessions modified at or after it."),
    modifiedBefore: string("ISO timestamp; sessions modified at or before it."),
    limit: count("Maximum sessions to return. Default 30, maximum 100.", 1, 100),
    offset: count("Sessions to skip, for paging.", 0, 100_000),
  },
};

const historyParameters = {
  type: "object",
  additionalProperties: false,
  required: ["sessionId"],
  properties: {
    sessionId: string("Session id from sessions_search or sessions_list."),
    entryId: string("Read around the turn containing this entry. Use with contextTurnsBefore/After."),
    contextTurnsBefore: count("Turns before the anchored turn. Default 1.", 0, 100),
    contextTurnsAfter: count("Turns after the anchored turn. Default 1.", 0, 100),
    since: string("ISO timestamp; entries at or after it. A bare date means that local calendar day."),
    until: string("ISO timestamp; entries at or before it."),
    lastTurns: count("The last N turns of the active branch. Default 1 when no selector is given.", 1, 200),
    everything: { type: "boolean", description: "Include thinking, tool calls, tool output and compaction summaries. Default false." },
  },
};

/**
 * The tool definitions, with the backend resolved at execution time so a
 * session that starts before the plugin is healthy can still use them later.
 *
 * Parameter schemas are plain JSON Schema: `pi.registerTool` validates the shape
 * at registration and the model-facing declaration is the schema itself, so no
 * TypeBox import is needed and the module runs under `node --test`.
 */
export function createSessionTools({ resolveBackend }) {
  const tool = ({ operation, ...definition }) => ({
    exposure: "deferred",
    namespace: NAMESPACE,
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    ...definition,
    async execute(_toolCallId, input, signal) {
      const backend = resolveBackend();
      const result = await requestBackend(backend, operation, input, signal);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });

  return [
    tool({
      name: "sessions_search",
      label: "Search sessions",
      operation: SEARCH_OPERATION,
      parameters: searchParameters,
      description: "Search the text of this machine's past conversations. Returns matching messages grouped by session, each with a snippet, the entry id to read more with sessions_history, and the session's name.",
    }),
    tool({
      name: "sessions_list",
      label: "List sessions",
      operation: LIST_OPERATION,
      parameters: listParameters,
      description: "List conversations on this machine, newest first, with their names, projects, folders and last activity. Use filters to find a conversation by metadata rather than by its contents.",
    }),
    tool({
      name: "sessions_history",
      label: "Read session history",
      operation: HISTORY_OPERATION,
      parameters: historyParameters,
      description: "Read a conversation's transcript around an entry with adjacent turns, inside a time range, or its last turns. Conversation text by default; everything: true adds thinking, tool calls and tool output.",
    }),
  ];
}
