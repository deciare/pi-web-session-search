/**
 * Peer operation names, in one place.
 *
 * The host validates every operation against `/^[a-z][a-z0-9.-]*$/u` and a 128
 * character limit, so an operation written with a capital letter is rejected at
 * the transport layer before the plugin sees it — which is exactly how the
 * panel's Save and Rebuild buttons once failed with "must match" instead of a
 * useful error. One list, imported by the server and the panel, plus a test that
 * checks every name against the host's rule.
 */

export const SEARCH_OPERATION = "search";
export const LIST_OPERATION = "list";
export const HISTORY_OPERATION = "history";
export const REBUILD_INDEX_OPERATION = "rebuild-index";
export const INDEX_STATUS_OPERATION = "index-status";
export const CONFIG_OPERATION = "config";
export const SET_CONFIG_OPERATION = "set-config";

export const OPERATIONS = Object.freeze([
  SEARCH_OPERATION,
  LIST_OPERATION,
  HISTORY_OPERATION,
  REBUILD_INDEX_OPERATION,
  INDEX_STATUS_OPERATION,
  CONFIG_OPERATION,
  SET_CONFIG_OPERATION,
]);

/** The host's rule, mirrored so a test can hold the list to it. */
export const OPERATION_NAME = /^[a-z][a-z0-9.-]*$/u;
export const OPERATION_NAME_MAX_LENGTH = 128;
