/** Snippet construction shared by the index and the scan, so both agree. */

export const SNIPPET_WIDTH = 160;

/**
 * A window of `text` around the first case-insensitive occurrence of `query`,
 * plus that occurrence's offset and length in the original text.
 *
 * @param {string} text
 * @param {string} query
 */
export function matchSnippet(text, query) {
  const needle = query.toLowerCase();
  const index = needle === "" ? -1 : text.toLowerCase().indexOf(needle);
  if (index === -1) {
    return { snippet: collapse(text.slice(0, SNIPPET_WIDTH)), matchStart: 0, matchLength: 0 };
  }
  const lead = Math.min(index, Math.max(0, Math.floor((SNIPPET_WIDTH - needle.length) / 2)));
  let start = Math.max(0, index - lead);
  let end = Math.min(text.length, start + SNIPPET_WIDTH);
  if (end - start < SNIPPET_WIDTH) start = Math.max(0, end - SNIPPET_WIDTH);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return {
    snippet: collapse(`${prefix}${text.slice(start, end)}${suffix}`),
    matchStart: index,
    matchLength: needle.length,
  };
}

function collapse(text) {
  return text.replace(/\s+/gu, " ").trim();
}
