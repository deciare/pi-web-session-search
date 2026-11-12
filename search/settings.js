import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The plugin's own settings, in its persistent data directory.
 *
 * `settings.json` is *not* under the installed package: the plugins directory is
 * output that `scripts/install.js` replaces whole, so configuration kept there
 * would disappear on the next upgrade. The host creates one data directory per
 * plugin (`plugin-data/<id>`) for state that outlives the package.
 *
 * A hand edit is picked up on the next read — the file's size and mtime are
 * checked first — so changing the time format does not need a daemon restart,
 * only a page reload. Writes are atomic within the directory.
 */

export const RELATIVE = "relative";
export const SETTINGS_FILE = "settings.json";

/** The same normalisation the panel applies, so a written value round-trips. */
export function normalizeTimeFormat(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" ? RELATIVE : text;
}

/**
 * @param {{ dataDirectory: string, logger?: { warn: (message: string) => void } }} options
 */
export function createSettingsStore(options) {
  const path = join(options.dataDirectory, SETTINGS_FILE);
  let cached;

  async function readRaw() {
    const info = await stat(path).catch(() => undefined);
    const key = info === undefined ? "missing" : `${info.mtimeMs}:${info.size}`;
    if (cached?.key === key) return cached;
    let settings = {};
    if (info !== undefined) {
      try {
        const parsed = JSON.parse(await readFile(path, "utf8"));
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed;
      } catch (error) {
        options.logger?.warn(`session search settings.json is unreadable; using defaults (${messageOf(error)})`);
      }
    }
    cached = { key, settings };
    return cached;
  }

  return {
    path,

    async read() {
      const { settings } = await readRaw();
      return { timeFormat: normalizeTimeFormat(settings["timeFormat"]) };
    },

    async write(input) {
      const { settings } = await readRaw();
      const next = { ...settings, timeFormat: normalizeTimeFormat(input?.timeFormat) };
      const temporary = `${path}.tmp`;
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      await rename(temporary, path);
      cached = undefined;
      return { timeFormat: next.timeFormat };
    },
  };
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
