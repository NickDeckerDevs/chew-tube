/*
5/22/2026 - nick decker | db utility
ADDED
- One-shot script: finds rows with HTML entities in `title` or `channel` columns and decodes them
- Uses `updateVideoColumn()` from db.ts and `decodeHtml()` from utils.ts
- Safe to re-run — only touches rows where entities are detected
- Run via `npm run fix-titles`
*/

import "dotenv/config";
import { listVideos, updateVideoColumn } from "./db.js";
import { decodeHtml } from "./utils.js";

const HTML_ENTITY_RE = /&(?:#\d+|#x[\da-fA-F]+|[a-zA-Z]+);/;

function main(): void {
  const videos = listVideos(9999);
  let fixed = 0;

  for (const v of videos) {
    if (HTML_ENTITY_RE.test(v.title)) {
      const decoded = decodeHtml(v.title);
      console.log(`[title]   "${v.title}"`);
      console.log(`       → "${decoded}"\n`);
      updateVideoColumn(v.id, "title", decoded);
      fixed++;
    }

    if (v.channel && HTML_ENTITY_RE.test(v.channel)) {
      const decoded = decodeHtml(v.channel);
      console.log(`[channel] "${v.channel}"`);
      console.log(`       → "${decoded}"\n`);
      updateVideoColumn(v.id, "channel", decoded);
      fixed++;
    }
  }

  if (fixed === 0) {
    console.log("No HTML entities found — nothing to fix.");
  } else {
    console.log(`Fixed ${fixed} field(s).`);
  }
}

main();
