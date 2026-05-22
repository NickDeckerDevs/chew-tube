/*
5/22/2026 - nick decker | email revisions
ADDED
- One-shot backfill script for existing DB rows missing `thumbnail_url` or `short_summary`
- Thumbnails: batch-fetches up to 50 IDs at a time via YouTube `videos.list`
- Short summaries: generates 2-3 sentences from stored `one_liner` + `takeaways` via Claude Haiku
- Run once via `npm run backfill` — safe to re-run (only touches NULL rows)
*/

import "dotenv/config";
import { youtube } from "@googleapis/youtube";
import Anthropic from "@anthropic-ai/sdk";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { decodeHtml } from "./utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "../../data/summaries.db");
const db = new Database(DB_PATH);
for (const stmt of [
  "ALTER TABLE videos ADD COLUMN thumbnail_url TEXT",
  "ALTER TABLE videos ADD COLUMN short_summary TEXT",
]) {
  try { db.exec(stmt); } catch {}
}

async function backfillThumbnails(): Promise<void> {
  const yt = youtube({ version: "v3", auth: process.env.YOUTUBE_API_KEY! });
  const rows = db.prepare(
    "SELECT id FROM videos WHERE thumbnail_url IS NULL"
  ).all() as { id: string }[];

  if (rows.length === 0) {
    console.log("Thumbnails: nothing to backfill.");
    return;
  }

  console.log(`Thumbnails: backfilling ${rows.length} rows...`);
  let updated = 0;

  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50).map((r) => r.id);
    const res = await yt.videos.list({ part: ["snippet"], id: batch });
    for (const item of res.data.items ?? []) {
      const url = item.snippet?.thumbnails?.medium?.url;
      if (url && item.id) {
        db.prepare("UPDATE videos SET thumbnail_url = ? WHERE id = ?").run(url, item.id);
        updated++;
      }
    }
  }

  console.log(`Thumbnails: updated ${updated} / ${rows.length} rows.`);
}

async function backfillShortSummaries(): Promise<void> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  const rows = db.prepare(
    "SELECT id, title, one_liner, takeaways FROM videos WHERE short_summary IS NULL OR short_summary = ''"
  ).all() as { id: string; title: string; one_liner: string; takeaways: string }[];

  if (rows.length === 0) {
    console.log("Short summaries: nothing to backfill.");
    return;
  }

  console.log(`Short summaries: backfilling ${rows.length} rows...`);

  for (const row of rows) {
    const takeaways = JSON.parse(row.takeaways) as string[];
    const res = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
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
      db.prepare("UPDATE videos SET short_summary = ? WHERE id = ?").run(text.trim(), row.id);
    }
    process.stdout.write(".");
  }

  console.log(`\nShort summaries: updated ${rows.length} rows.`);
}

async function main(): Promise<void> {
  await backfillThumbnails();
  await backfillShortSummaries();
  console.log("Backfill complete.");
  db.close();
}

main().catch((err) => {
  console.error("Fatal:", err.message ?? err);
  process.exit(1);
});
