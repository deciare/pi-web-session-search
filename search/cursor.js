import { createHash } from "node:crypto";

/**
 * Cursors are opaque to the browser and bound to one query: a page request
 * whose query or archive filter changed starts over rather than stitching two
 * result sets together.
 */
export function queryFingerprint(query, includeArchived) {
  return createHash("sha256")
    .update(`${query}\u0000${includeArchived ? "1" : "0"}`)
    .digest("base64url")
    .slice(0, 12);
}

/** @param {Record<string, unknown>} value */
export function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor(text, fingerprint) {
  if (typeof text !== "string" || text === "") return undefined;
  try {
    const value = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
    if (value === null || typeof value !== "object" || value.q !== fingerprint) return undefined;
    return value;
  } catch {
    return undefined;
  }
}
