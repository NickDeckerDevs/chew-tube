/*
5/22/2026 - nick decker | email revisions
ADDED
- One-shot backfill script for existing DB rows missing `thumbnail_url` or `short_summary`
- Thumbnails: batch-fetches up to 50 IDs at a time via YouTube `videos.list`
- Short summaries: generates 2-3 sentences from stored `one_liner` + `takeaways` via Claude Haiku
- Run once via `npm run backfill` — safe to re-run (only touches NULL rows)

5/22/2026 - nick decker | refactor
CHANGED
- Removed local DB setup and duplicate migration — now uses `getDb()` from db.ts
- Removed local YouTube client — now uses `getYouTube()` from youtube.ts
- Removed local Anthropic client — now uses `getAnthropicClient()` from utils.ts
- Removed hardcoded model string — now uses `HAIKU_MODEL` from utils.ts
- Uses `updateVideoColumn()` from db.ts for all UPDATE operations
- Error handling via `runScript()` from utils.ts
*/

import "dotenv/config";
import { getDb, updateVideoColumn } from "./db.js";
import { getYouTube } from "./youtube.js";
import { getAnthropicClient, HAIKU_MODEL, runScript } from "./utils.js";

async function backfillThumbnails(): Promise<void> {
  const rows = getDb().prepare(
    "SELECT id FROM videos WHERE thumbnail_url IS NULL"
  ).all() as { id: string }[];

  if (rows.length === 0) {
    console.log("Thumbnails: nothing to backfill.");
    return;
  }

  console.log(`Thumbnails: backfilling ${rows.length} rows...`);
  let updated = 0;
  const yt = getYouTube();

  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50).map((r) => r.id);
    const res = await yt.videos.list({ part: ["snippet"], id: batch });
    for (const item of res.data.items ?? []) {
      const url = item.snippet?.thumbnails?.medium?.url;
      if (url && item.id) {
        updateVideoColumn(item.id, "thumbnail_url", url);
        updated++;
      }
    }
  }

  console.log(`Thumbnails: updated ${updated} / ${rows.length} rows.`);
}

async function backfillShortSummaries(): Promise<void> {
  const rows = getDb().prepare(
    "SELECT id, title, one_liner, takeaways FROM videos WHERE short_summary IS NULL OR short_summary = ''"
  ).all() as { id: string; title: string; one_liner: string; takeaways: string }[];

  if (rows.length === 0) {
    console.log("Short summaries: nothing to backfill.");
    return;
  }

  console.log(`Short summaries: backfilling ${rows.length} rows...`);
  const client = getAnthropicClient();

  for (const row of rows) {
    const takeaways = JSON.parse(row.takeaways) as string[];
    const res = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 256,
      messages: [{
        role: "user",
        content: `Write a 2-3 sentence summary of this YouTube video for a daily digest email preview. Plain prose only — no markdown, no headers, no bullet points. Write only the sentences, nothing else.

Title: "${row.title}"
One-liner: ${row.one_liner}
Key points:
${takeaways.map((t) => `- ${t}`).join("\n")}`,
      }],
    });

    const text = (res.content.find((b) => b.type === "text") as { text: string } | undefined)?.text ?? "";
    if (text.trim()) {
      updateVideoColumn(row.id, "short_summary", text.trim());
    }
    process.stdout.write(".");
  }

  console.log(`\nShort summaries: updated ${rows.length} rows.`);
}

async function main(): Promise<void> {
  await backfillThumbnails();
  await backfillShortSummaries();
  console.log("Backfill complete.");
}

runScript(main);
