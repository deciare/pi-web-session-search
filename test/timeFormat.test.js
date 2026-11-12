import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ABSOLUTE_PATTERN, formatAbsolute, formatRelative, formatTimestamp, normalizeTimeFormat } from "../browser/timeFormat.js";

const preferences = { formatLocale: "en-US", timeZone: "America/Toronto" };
const localization = {
  preferences,
  relativeTime: (value, unit) => new Intl.RelativeTimeFormat("en-US", { numeric: "auto" }).format(value, unit),
  date: (date, options) => new Intl.DateTimeFormat("en-US", { timeZone: preferences.timeZone, ...options }).format(date),
};
const instant = new Date("2026-11-12T05:49:05.000Z");
const at = (iso) => new Date(iso).getTime();

test("the default format is an absolute pattern", () => {
  assert.equal(formatAbsolute(instant, DEFAULT_ABSOLUTE_PATTERN, preferences), "2026-11-12 00:49:05");
});

test("the pattern language covers date, time, names, zone and literal percent", () => {
  assert.equal(formatAbsolute(instant, "%F %T", preferences), "2026-11-12 00:49:05");
  assert.equal(formatAbsolute(instant, "%a %d %b %Y", preferences), "Thu 12 Nov 2026");
  assert.equal(formatAbsolute(instant, "%A, %B %d", preferences), "Thursday, November 12");
  assert.equal(formatAbsolute(instant, "%I:%M %p", preferences), "12:49 AM");
  assert.equal(formatAbsolute(instant, "%H:%M %Z", preferences), "00:49 EST");
  assert.equal(formatAbsolute(instant, "%z", preferences), "-0500");
  assert.equal(formatAbsolute(instant, "100%% done", preferences), "100% done");
});

test("an unknown token is left as written so a typo is visible", () => {
  assert.equal(formatAbsolute(instant, "%Q %Y", preferences), "%Q 2026");
});

test("relative time rounds to a unit and falls back to a date past a month", () => {
  assert.equal(formatTimestamp(instant, "relative", localization, at("2026-11-12T06:09:05.000Z")), "20 minutes ago");
  assert.equal(formatTimestamp(instant, "relative", localization, at("2026-11-13T03:49:05.000Z")), "22 hours ago");
  assert.equal(formatTimestamp(instant, "relative", localization, at("2026-11-15T05:49:05.000Z")), "3 days ago");
  const longAgo = formatTimestamp(instant, "relative", localization, at("2027-02-01T00:00:00.000Z"));
  assert.match(longAgo, /Nov 12, 2026/u);
});

test("blank and missing values mean relative time", () => {
  for (const value of [undefined, null, "", "   "]) {
    assert.equal(normalizeTimeFormat(value), "relative");
  }
  assert.equal(normalizeTimeFormat("  %Y-%m-%d  "), "%Y-%m-%d");
  assert.equal(formatTimestamp(instant, "", localization, at("2026-11-12T06:09:05.000Z")), "20 minutes ago");
});

test("an invalid timestamp renders nothing", () => {
  assert.equal(formatTimestamp("not a date", DEFAULT_ABSOLUTE_PATTERN, localization), "");
  assert.equal(formatTimestamp("not a date", "relative", localization), "");
});

test("relative time without a localization still renders something", () => {
  assert.notEqual(formatRelative(instant, undefined, at("2026-11-12T05:29:05.000Z")), "");
});
