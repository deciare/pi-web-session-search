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
    timeFormatButton: message("Time format", "Footer button that opens the timestamp format dialog"),
    timeFormatTitle: message("Time format", "Dialog title for choosing how timestamps are shown"),
    timeFormatLabel: message("Pattern, or relative", "Label for the timestamp format input"),
    timeFormatHint: message("relative shows “22 hours ago”. A pattern shows an absolute time: %Y year, %m month, %d day, %H hour (24h), %M minute, %S second, %p AM/PM, %b/%B month name, %a/%A weekday, %Z zone, %% a literal percent.", "Explanation of the timestamp format setting"),
    timeFormatSaveFailed: message("Could not save the time format: {message}", "Writing settings.json failed; message is the error text"),
    cancel: message("Cancel", "Dismiss the dialog without saving"),
    save: message("Save", "Apply the timestamp format"),
    indexing: message("Indexing {done}/{total}", "Index build progress; done and total are file counts"),
    indexedResults: message("Indexed results in {ms} ms", "Results were answered from the index; ms is a duration in milliseconds"),
    scannedResults: message("Transcript scan in {ms} ms", "Results were answered by reading transcripts; ms is a duration in milliseconds"),
    truncated: message("Results are incomplete — the scan reached its time budget.", "Scan fallback ran out of time"),
    archived: message("archived", "Badge marking an archived session"),
    archivedFilter: message("Include archived", "Checkbox label for including archived sessions in results"),
    archivedFilterTitle: message("Include archived sessions in results", "Tooltip for the archived filter"),
    user: message("you", "Role label for a user message hit"),
    assistant: message("assistant", "Role label for an assistant message hit"),
    question: message("question", "Role label for an ask-card hit"),
    note: message("note", "Role label for a host note hit, such as an answer summary"),
    openFailed: message("Could not open that session: {message}", "Navigation failed; message is the error text"),
  };
}
