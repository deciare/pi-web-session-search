/**
 * Install this package into a PI WEB plugins directory.
 *
 *   node scripts/install.js /data/pi-web/plugins/session-search
 *
 * The source tree is canonical; the installed copy is output. This replaces the
 * destination whole, so leftover files from an older version cannot survive and
 * an edit made in the installed copy is never mistaken for the source.
 */
import { cp, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const target = process.argv[2];

if (target === undefined) {
  console.error("usage: node scripts/install.js <plugins-directory>/session-search");
  console.error(`source: ${root}`);
  process.exit(1);
}

const destination = resolve(target);
if (destination === root) {
  console.error("refusing to install over the source tree");
  process.exit(1);
}
if (destination.startsWith(`${root}/`)) {
  console.error("refusing to install inside the source tree");
  process.exit(1);
}

await rm(destination, { recursive: true, force: true });
await cp(root, destination, {
  recursive: true,
  filter: (source) => {
    const name = basename(source);
    return name !== ".git" && name !== "node_modules";
  },
});

console.log(`installed to ${destination}`);
console.log("restart the session daemon, then reload the browser page");
