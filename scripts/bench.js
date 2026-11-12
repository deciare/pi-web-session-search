import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCorpus, listCandidates } from "../search/corpus.js";
import { SearchIndex } from "../search/index-store.js";

/**
 * Numbers for the README: cold build, warm query latency and scan latency
 * against the live corpus. Read-only on the transcripts; the index is built in
 * a temporary directory and deleted afterwards.
 *
 *   node scripts/bench.js ["query" ...]
 */
const queries = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : ["rollback", "session", "plugin", "the", "config", "error"];

const corpus = resolveCorpus();
const candidates = await listCandidates(corpus, { includeArchived: true });
const totalBytes = candidates.reduce((sum, file) => sum + file.size, 0);
console.log(`${candidates.length} transcripts, ${(totalBytes / 1e6).toFixed(1)} MB`);
console.log(`session dir: ${corpus.sessionDir}`);
console.log(`archive dir: ${corpus.archiveDir}`);

const dataDirectory = await mkdtemp(join(tmpdir(), "session-search-bench-"));
const index = new SearchIndex({
  dataDirectory,
  corpus,
  logger: { debug() {}, info() {}, warn: (message) => console.warn(message), error() {} },
});
try {
  const buildStarted = performance.now();
  await index.runPass();
  const buildMs = performance.now() - buildStarted;
  const info = await stat(index.dbPath);
  console.log(`cold build: ${buildMs.toFixed(0)} ms, index ${(info.size / 1e6).toFixed(1)} MB`);

  for (const query of queries) {
    for (let round = 0; round < 2; round += 1) await index.search({ query });
    const indexed = [];
    const scanned = [];
    for (let round = 0; round < 15; round += 1) {
      const started = performance.now();
      const warm = await index.search({ query });
      indexed.push(performance.now() - started);
      if (round === 0) console.log(`  ${JSON.stringify(query)}: ${warm.total} matches, ${warm.hits.length} hits, source ${warm.source}`);
    }
    // Force the scan through a budget large enough to complete.
    const { scanSessions } = await import("../search/scanner.js");
    for (let round = 0; round < 5; round += 1) {
      const started = performance.now();
      await scanSessions(corpus, { query, includeArchived: true }, { budgetMs: 10_000 });
      scanned.push(performance.now() - started);
    }
    console.log(`  index p50 ${percentile(indexed, 50).toFixed(1)} ms p95 ${percentile(indexed, 95).toFixed(1)} ms`
      + ` · scan p50 ${percentile(scanned, 50).toFixed(0)} ms p95 ${percentile(scanned, 95).toFixed(0)} ms`);
  }
} finally {
  index.dispose();
  await rm(dataDirectory, { recursive: true, force: true });
}

function percentile(values, p) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}
