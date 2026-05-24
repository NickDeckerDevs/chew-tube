/*
5/23/2026 - nick decker | backfill-scores
ADDED
- One-shot script: backfills `score`, `score_raw`, `score_penalty`, `score_breakdown`, and `source_type` for all existing videos rows where `score IS NULL`
- `source_type` inferred in priority order:
    1. Match by video ID in the queue table (authoritative)
    2. Match `channel` name against config.json channel labels (heuristic)
    3. Default to "topic"
- Rows with no scoreable signals (persona_match IS NULL, no clickbait, not a channel source) will produce score=0 — stored as 0, not NULL, so they don't re-run
- Prints a summary: total rows, skipped (already scored), updated, and a source_type breakdown
*/

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getDb } from "./db.js";
import { computeScore } from "./scorer.js";
import { runScript } from "./utils.js";
import type { ScoreBreakdown } from "./scorer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type VideoRow = {
  id: string;
  channel: string;
  persona_match: string | null;
  channel_categories_matched: number | null;
  clickbait: number | null;
  category_id: string | null;
};

type ConfigChannel = { label: string };
type Config = { channels: ConfigChannel[]; settings: { categoryPreferences?: Record<string, number> } };

async function main(): Promise<void> {
  const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../config.json"), "utf-8")
  ) as Config;

  const configChannelLabels = new Set(config.channels.map((c) => c.label));
  const categoryPrefs = config.settings.categoryPreferences ?? {};

  const db = getDb();

  // Build a lookup: video ID → source_type from queue table
  const queueSourceTypes = new Map<string, string>(
    (db.prepare("SELECT id, source_type FROM queue").all() as { id: string; source_type: string }[])
      .map((r) => [r.id, r.source_type])
  );

  const rows = db.prepare(`
    SELECT id, channel, persona_match, channel_categories_matched, clickbait, category_id
    FROM videos
    WHERE score IS NULL
  `).all() as VideoRow[];

  const updateScore = db.prepare(`
    UPDATE videos
    SET source_type = ?, score = ?, score_raw = ?, score_penalty = ?, score_breakdown = ?
    WHERE id = ?
  `);

  const counts = { total: rows.length, updated: 0, channel: 0, topic: 0, queueMatch: 0 };

  const run = db.transaction(() => {
    for (const row of rows) {
      // Resolve source type
      let sourceType: "channel" | "topic" = "topic";
      if (queueSourceTypes.has(row.id)) {
        sourceType = queueSourceTypes.get(row.id) as "channel" | "topic";
        counts.queueMatch++;
      } else if (configChannelLabels.has(row.channel)) {
        sourceType = "channel";
      }

      if (sourceType === "channel") counts.channel++;
      else counts.topic++;

      // Resolve category score
      const categoryScore = row.category_id ? (categoryPrefs[row.category_id] ?? 3) : 3;

      const signals = {
        personaMatch: row.persona_match as "strong" | "partial" | "none" | null,
        channelCategoriesMatched: row.channel_categories_matched,
        clickbait: row.clickbait === null ? null : row.clickbait === 1,
      };

      const { score, scoreRaw, scorePenalty, breakdown } = computeScore(signals, sourceType, categoryScore);

      updateScore.run(
        sourceType,
        score,
        scoreRaw,
        scorePenalty,
        JSON.stringify(breakdown),
        row.id
      );
      counts.updated++;
    }
  });

  run();

  console.log(`\nBackfill complete`);
  console.log(`  Total eligible:  ${counts.total}`);
  console.log(`  Updated:         ${counts.updated}`);
  console.log(`  Source — channel: ${counts.channel}  (${counts.queueMatch} from queue, ${counts.channel - counts.queueMatch} by channel name match)`);
  console.log(`  Source — topic:  ${counts.topic}`);

  if (counts.total === 0) console.log(`  Nothing to do — all rows already have scores.`);
}

runScript(main);
