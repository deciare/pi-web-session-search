/**
 * Timestamp display: a relative phrase, or an absolute pattern.
 *
 * The setting is one value, so the two are mutually exclusive by construction:
 * `relative` (the default) or a pattern such as `%Y-%m-%d %H:%M:%S`. A mixed
 * value would need a token the pattern language does not have, and there is no
 * reason to invent one until somebody asks for it.
 *
 * The pattern language is strftime's, minus the parts that need a library: `%Y`
 * year, `%m` month, `%d` day, `%H` hour (24), `%I` hour (12), `%M` minute, `%S`
 * second, `%p` AM/PM, `%b`/`%B` month name, `%a`/`%A` weekday, `%Z` zone name,
 * `%z` numeric offset, `%F` date, `%T` time, `%%` a literal percent. An unknown
 * token is left as written, so a typo is visible rather than silently dropped.
 */

export const RELATIVE = "relative";
export const DEFAULT_ABSOLUTE_PATTERN = "%Y-%m-%d %H:%M:%S";

const formatters = new Map();

/** A stored or typed value, with blank meaning the default. */
export function normalizeTimeFormat(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" ? RELATIVE : text;
}

export function formatTimestamp(value, format, localization, now = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const resolved = normalizeTimeFormat(format);
  return resolved === RELATIVE
    ? formatRelative(date, localization, now)
    : formatAbsolute(date, resolved, localization?.preferences);
}

/** "22 hours ago", with a plain date past a month. */
export function formatRelative(date, localization, now = Date.now()) {
  const seconds = Math.round((date.getTime() - now) / 1000);
  const magnitude = Math.abs(seconds);
  const [value, unit] = magnitude < 60 ? [seconds, "second"]
    : magnitude < 3_600 ? [Math.round(seconds / 60), "minute"]
      : magnitude < 86_400 ? [Math.round(seconds / 3_600), "hour"]
        : magnitude < 2_592_000 ? [Math.round(seconds / 86_400), "day"]
          : [undefined, undefined];
  if (value !== undefined && unit !== undefined) {
    try {
      return localization.relativeTime(value, unit);
    } catch {
      // Fall through to the date.
    }
  }
  try {
    return localization.date(date, { dateStyle: "medium" });
  } catch {
    return date.toLocaleDateString();
  }
}

export function formatAbsolute(date, pattern, preferences) {
  const parts = calendarParts(date, preferences);
  return pattern.replace(/%([A-Za-z%])/g, (match, token) => expand(token, date, preferences, parts) ?? match);
}

function expand(token, date, preferences, parts) {
  switch (token) {
    case "%": return "%";
    case "Y": return parts.year;
    case "m": return parts.month;
    case "d": return parts.day;
    case "H": return parts.hour;
    case "M": return parts.minute;
    case "S": return parts.second;
    case "I": return partOf(date, preferences, { hour: "2-digit", hourCycle: "h12" }, "hour");
    case "p": return partOf(date, preferences, { hour: "numeric", hourCycle: "h12" }, "dayPeriod") ?? "";
    case "b": return named(date, preferences, "month", "short");
    case "B": return named(date, preferences, "month", "long");
    case "a": return named(date, preferences, "weekday", "short");
    case "A": return named(date, preferences, "weekday", "long");
    case "Z": return partOf(date, preferences, { timeZoneName: "short" }, "timeZoneName") ?? "";
    case "z": return numericOffset(date, preferences) ?? "";
    case "F": return `${parts.year}-${parts.month}-${parts.day}`;
    case "T": return `${parts.hour}:${parts.minute}:${parts.second}`;
    // An unknown token stays as typed.
    default: return undefined;
  }
}

function calendarParts(date, preferences) {
  const parts = {};
  for (const part of formatter(preferences, {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hourCycle: "h23", minute: "2-digit", second: "2-digit",
  }).formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return parts;
}

function partOf(date, preferences, options, type) {
  return formatter(preferences, options).formatToParts(date)
    .find((part) => part.type === type)?.value;
}

function named(date, preferences, type, style) {
  try {
    return formatter(preferences, { [type]: style }).format(date);
  } catch {
    return "";
  }
}

/** `-0500` from the formatter's `GMT-05:00`, or `+0000` for plain `GMT`. */
function numericOffset(date, preferences) {
  try {
    const name = partOf(date, preferences, { timeZoneName: "longOffset" }, "timeZoneName");
    if (typeof name !== "string") return undefined;
    const match = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/u.exec(name);
    if (match !== null) return `${match[1]}${match[2].padStart(2, "0")}${(match[3] ?? "00").padStart(2, "0")}`;
    return name.includes("GMT") ? "+0000" : undefined;
  } catch {
    return undefined;
  }
}

function formatter(preferences, options) {
  const locale = preferences?.formatLocale;
  const timeZone = preferences?.timeZone;
  const key = JSON.stringify([locale, timeZone, options]);
  let value = formatters.get(key);
  if (value === undefined) {
    value = new Intl.DateTimeFormat(locale, { ...(timeZone === undefined ? {} : { timeZone }), ...options });
    formatters.set(key, value);
  }
  return value;
}
