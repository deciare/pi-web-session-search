/** Panel strings, registered through the host's localization API. */

export function createSearchMessages(localization) {
  const message = localization.message;
  return {
    title: message("Search", "Search panel title"),
    placeholder: message("Search all sessions…", "Search input placeholder"),
    searchLabel: message("Search session transcripts", "Accessible label for the search input"),
    emptyQuery: message("Search the text of every session on this machine.", "Panel state before a query is typed"),
    noResults: message("No matches.", "Search completed with no results"),
    searching: message("Searching…", "Search request is pending"),
    unavailable: message("Search backend unavailable on this machine. Reload the page or restart the session daemon.", "Paired server plugin is missing"),
    failed: message("Search failed. {message}", "Search request failed; message is the error text"),
    loadMore: message("Load more", "Load the next page of results"),
    rebuild: message("Rebuild index", "Delete and rebuild the search index"),
    rebuilding: message("Rebuilding index…", "A full index rebuild is running"),
    indexing: message("Indexing {done}/{total}", "Index build progress; done and total are file counts"),
    indexedResults: message("Indexed results in {ms} ms", "Results were answered from the index; ms is a duration in milliseconds"),
    scannedResults: message("Transcript scan in {ms} ms", "Results were answered by reading transcripts; ms is a duration in milliseconds"),
    truncated: message("Results are incomplete — the scan reached its time budget.", "Scan fallback ran out of time"),
    archived: message("archived", "Badge marking an archived session"),
    user: message("you", "Role label for a user message hit"),
    assistant: message("assistant", "Role label for an assistant message hit"),
    question: message("question", "Role label for an ask-card hit"),
    note: message("note", "Role label for a host note hit, such as an answer summary"),
    openFailed: message("Could not open that session: {message}", "Navigation failed; message is the error text"),
  };
}
