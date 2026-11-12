# Session search — full-text search over every transcript on this machine

A PI WEB plugin: one panel that searches the message text of every session in
`PI_CODING_AGENT_DIR/sessions` (and the archive), opens a hit's session, and —
with house patch `0013` — scrolls to the matched message.

The design record is `/data/home/src/pi-web-search-plan.md`. This README is the
implementation's own account: what it does, what it costs, and where it deviates
from that plan.

## What is searchable

- `user` and `assistant` messages, and only their `type: "text"` blocks. Never
  thinking blocks, tool calls or tool output.
- **Ask cards.** The question text, its supporting line, and the option labels
  the card offers. The card is rendered from a successful `ask_user` tool
  result's persisted `details`, so it is conversation rather than tool output;
  the model-facing result text is not indexed, and neither is option `detail`
  prose (it is behind a disclosure and reads like boilerplate).
- **Host notes the transcript displays**, such as the answer summary written
  after an ask is submitted. Their content is visible to the reader, so a hit
  can scroll to it. Custom messages with `display: false` stay out, as does
  every other system message.
- The **active branch only**: the transcript shows one root-to-leaf chain, and a
  hit the reader cannot see would be a bug. Rewinding history inside a session
  moves the leaf, and the abandoned branch stops being searchable on the next
  pass.
- Compaction and branch summaries are not messages, so they are not in the
  corpus. Pre-compaction messages are still messages, still in the file, and
  still searchable.
- Substring semantics, not word matching: the index uses FTS5's `trigram`
  tokeniser, so `roll` finds `rollback` and `resolvePlug` finds
  `resolvePluginNavigation`. Queries shorter than three characters bypass the
  index and use the scan.

## Two code paths, one predicate

`search/predicate.js` decides what a searchable message is, and both the
indexer and the transcript scan call it. The scan is not a stepping stone: it is
what makes the promise true that search never stops working. If the index is
missing, cold, unusable, being rebuilt or mid-corruption-recovery, the query is
answered by reading transcripts, and the response says `source: "scan"`.

The scan skips JSON parsing for lines whose raw bytes cannot contain the query
(the text is stored verbatim) and for anything that is not a message. The one
case where that shortcut is disabled is a query containing `"`, `\` or a control
character — JSON escapes those, so the raw bytes no longer match the text.

## The index is a cache

`index.sqlite3` lives in the plugin's own data directory
(`$PI_WEB_DATA_DIR/plugin-data/session-search/`) and is disposable. Delete it at
any moment, truncate it, or overwrite it with random bytes: the next query
answers from the scan, the next pass rebuilds, and the only cost is time. The
panel has a **Rebuild index** button because that should be ordinary, not a
support procedure.

- **Schema version** mismatch, or `PRAGMA quick_check` failure at open → the file
  is closed, deleted, recreated and rebuilt.
- **Any statement failure** (`SQLITE_CORRUPT`, `SQLITE_NOTADB`, `SQLITE_IOERR`,
  `SQLITE_READONLY_DBMOVED`, a vanished or replaced file) → the handle is
  dropped, the files are best-effort deleted, the query falls back to the scan,
  and a pass is scheduled. If deletion itself fails (permissions, a lingering
  handle), the plugin stays in scan mode for the life of the process and records
  one notice instead of retrying per query.
- **Two handles**: one writer and one reader. `DatabaseSync` is synchronous and
  runs inside the session daemon, so a build inserts in batches and yields
  between them; a reader on its own WAL connection sees the last committed
  state, never half a session.
- **Incremental sync** reads only bytes past the last complete line, and only
  when the first new entry chains from the previously indexed leaf. A branch
  change, a shrink, a path change, or a rewrite that keeps the size but changes
  the mtime reindexes that session from zero; a file that only gained a torn
  line is left alone. `leaf_id` is the one column this implementation adds to
  the planned `sync_state`, and it is what makes the chain check cheap.
- **One unreadable transcript does not discard the index.** A per-file read
  failure is logged once and skipped; only an index failure rebuilds it.
- **Interrupted builds** are the same as no build: `completeSinceRestart` stays
  false until a full pass over the corpus succeeds, and until then every query
  is answered by the scan. This is the only way a partially built index cannot
  quietly return half the results.

## Install and upgrade

The package is a plugin directory, like `house-theme`:

```sh
cp -r /data/home/src/pi-web-session-search /data/pi-web/plugins/session-search
```

Then:

- **Restart the session daemon.** The server half activates inside sessiond and
  is only discovered at startup. Restarting interrupts live sessions, so pick a
  quiet moment.
- **Reload the browser.** The panel appears as a tool tab, and can be disabled
  in Settings → Plugins like any other.

Upgrading the plugin is the same two steps. The package declares
`machineSpecific: true`: it indexes one machine's files and is served by that
machine's daemon, so a remote machine is searched by its own copy over the
plugin backend transport.

The panel is an application panel (no workspace required), ordered after the
built-in tools. It needs no filesystem permission of its own: it asks the
daemon, and the daemon already owns the transcripts.

## API

Peer operations, as implemented (v5 paired backend, machine scope):

- `search` — `{ query, limit?, cursor?, includeArchived? }` → `{ hits, total,
  nextCursor?, truncated, source, indexing: { done, total, rebuilding }, ms }`.
  Hits are ordered by session file modification time, newest first, then by
  position within the session. Each hit carries the durable `entryId`, a
  `snippet` and `matchStart`/`matchLength` into the message's full text. At most
  three hits per session, so one chatty session cannot flood the list; `total`
  still counts every matching message.
- `rebuildIndex` — closes, deletes and restarts the build; returns immediately.
- `indexStatus` — row and session counts, build progress, last error.

`query` is wrapped as an FTS5 quoted phrase, so `NEAR(`, `*` and `:` are literal
text, never syntax. An empty query returns no hits and never touches the index.

## The patch, and how it degrades

The plugin always sends `messageEntryId` in its navigation call. House patch
`0013` teaches the browser route to carry it and the chat view to scroll to that
message. **Without the patch the host drops the unknown field** (the route is
built field by field in `src/client/src/pluginNavigation.ts`) and opens the
session at the bottom. No version probe, no `requires`, no handshake.

## Measurements

Measured in this container on 2026-11-12, against the live corpus at the time —
49 transcripts, 72 MB, largest 4.3 MB:

| | cold build | warm query p50 | warm query p95 | scan p50 |
| --- | --- | --- | --- | --- |
| 72 MB corpus | 655 ms | 0.7–15 ms | 0.9–15 ms | ~300 ms |

The index was 9.4 MB — larger than any single query's working set and far
smaller than the transcripts. The trigram tokeniser is why the index is not
tiny; the database is disposable, so that is a disk cost, not a correctness one.
`scripts/bench.js` reproduces the table against whatever corpus is present.

Warm query cost tracks match count, not corpus size: `"the"` matched 1429
messages and took ~15 ms; `"rollback"` matched 12 and took under a millisecond.
The scan reads every transcript, so its cost tracks corpus size.

## Deviations from the plan

- **The corpus is wider than "message entries only".** The plan as first written
  made only `message` entries candidates, which left ask cards and answer
  summaries unsearchable even though both are visible in the transcript. The
  predicate covers them explicitly now, and the plan says so; `search/predicate.js`
  is still the one definition both paths use.
- **`position` in the FTS5 table has no declared type.** FTS5 column definitions
  are `name [UNINDEXED]`; `position INTEGER UNINDEXED` is a parse error. The
  plan's schema as written does not create. `position` is a byte offset in the
  session file — monotonic, stable across rebuilds, and known during an
  incremental read without a second column.
- **`sync_state.leaf_id`** is added (see above) so an append can be proved to
  extend the chain before its rows are inserted.
- **Snippets are built here, not by `snippet()`.** With a trigram tokeniser
  SQLite's `snippet()` reports trigram windows (`…, [roll]ba…`), which is not a
  readable hit. `matchSnippet` uses the same function for both paths.
- **The archive directory is resolved from the environment**
  (`PI_WEB_SESSION_ARCHIVE_DIR`, else `$PI_WEB_DATA_DIR/archived-sessions`). A
  config-file `sessionArchive.directory` override is not read; sessiond
  canonicalizes the agent and session directories into the environment, but the
  archive directory is not among them.

## Cost and limits

- **The index is bigger than the text it indexes.** Trigram postings are costly.
  Delete the file if disk matters more than latency; search keeps working.
- **A phrase spanning the boundary between two text blocks of one message** is
  found by the index (which stores the joined text) but can be missed by the
  scan's raw-line prefilter. The scan special-cases messages with more than one
  text block, so this only bites when the query also appears in no single block
  and the line has exactly one block — a query like `alphabeta` across
  `alpha` + `beta`. It is a documented divergence, not an unnoticed one.
- **Archived sessions are read from the archive directory**, and their metadata
  is derived from the file itself (id, cwd, mtime), not from
  `archived-sessions.json`. A transient live/archive duplicate resolves to the
  live copy.
- **The index tracks file modification time.** Two sessions edited within the
  same millisecond tie-break by session id, which is stable but arbitrary.
- **A snippet comes from the first 64,000 characters of the entry.** That is
  far above this corpus's longest message (18 KB), and it keeps a page of hits
  under the paired transport's 8 MB response limit. A longer message is still
  matched on its full text; only its snippet shows the start of the message and
  reports no match offset.
- **No permission or privacy boundary beyond the host's own.** Anyone who can
  open the PI WEB instance on this machine can search these transcripts, because
  the transcripts are already theirs. The plugin adds no network surface: the
  browser asks its own daemon over the existing paired transport.
- **Snippets and session names are rendered as text nodes.** Message text is
  untrusted input to the panel; nothing is injected as HTML.

## Tests

```sh
cd /data/home/src/pi-web-session-search
node --test test/*.test.js
PI_WEB_ROOT=/data/home/src/pi-web node scripts/panel-smoke.js
```

33 tests: block filtering (thinking and tool output excluded), ask cards and
answer notes (including a hidden note and a failed ask), compaction
exclusion with pre-compaction messages retained, abandoned branches, torn last
lines, the raw-line prefilter's safety conditions, snippet offsets, per-session
caps and scan truncation, archive marking and the live-copy preference,
incremental appends, branch-change reindexing, same-size rewrites, an emptied
transcript, a path reused by another session, naming, durability against a
missing/empty/corrupt/deleted/truncated index file, rebuild equivalence, dropped
sessions, index/scan agreement across queries, and cursor paging without gaps.

The browser half has no unit tests — it is one custom element and a
contribution. `scripts/panel-smoke.js` renders it in the pi-web checkout's
happy-dom with a fake backend and checks the module graph, the localized title,
the peer request, the rows and their role labels, the marked match, and the
navigation call (session, entry, `view: "chat"`, and the workspace resolved from
the hit's cwd).
