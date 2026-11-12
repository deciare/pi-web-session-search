import { open } from "node:fs/promises";

const NEWLINE = 0x0a;
const DEFAULT_CHUNK_BYTES = 1 << 20;

/**
 * Yield complete newline-terminated lines as `{ text, start, end }`, where
 * `start` and `end` are byte offsets in the file (`end` is past the newline).
 *
 * A trailing fragment with no newline is never yielded. A live session can be
 * mid-write, and a torn line is end of file, not an error: treating it as
 * content is what would make a scan return half a message.
 *
 * @param {string} filePath
 * @param {number} [startByte]
 * @param {number} [chunkBytes]
 */
export async function* readLines(filePath, startByte = 0, chunkBytes = DEFAULT_CHUNK_BYTES) {
  const handle = await open(filePath, "r");
  try {
    let position = startByte;
    let pending = Buffer.alloc(0);
    let pendingStart = startByte;
    for (;;) {
      const chunk = Buffer.allocUnsafe(chunkBytes);
      const { bytesRead } = await handle.read(chunk, 0, chunkBytes, position);
      if (bytesRead === 0) return;
      position += bytesRead;
      const next = chunk.subarray(0, bytesRead);
      pending = pending.length === 0 ? next : Buffer.concat([pending, next]);
      let from = 0;
      for (let index = pending.indexOf(NEWLINE); index !== -1; index = pending.indexOf(NEWLINE, from)) {
        const text = pending.subarray(from, index).toString("utf8");
        yield { text, start: pendingStart + from, end: pendingStart + index + 1 };
        from = index + 1;
      }
      if (from > 0) {
        pending = pending.subarray(from);
        pendingStart += from;
      }
    }
  } finally {
    await handle.close();
  }
}
