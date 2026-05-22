/*
5/22/2026 - nick decker | phase 1 task work
ADDED
- `getDbStats()` export returning DB path and row count
- Auto-creates `data/` directory on module load via `fs.mkdirSync`

CHANGED
- Added `fs` import

5/22/2026 - nick decker | email revisions
ADDED
- `thumbnailUrl` (optional) to `VideoMeta` — 320x180 medium thumbnail from YouTube API
- `shortSummary` to `Summary` — 2-3 sentence digest preview, stored separately from `oneLiner`

CHANGED
- Schema migration: `thumbnail_url TEXT` and `short_summary TEXT` columns added via `ALTER TABLE` (nullable, idempotent)
- `saveVideo` and `listVideos` updated to include both new fields

5/22/2026 - nick decker | db utility
ADDED
- `UPDATEABLE_COLUMNS` const list — exhaustive set of columns that may be updated after insert
- `updateVideoColumn(id, column, value)` — type-safe single-column UPDATE; column name validated against the allowlist to prevent SQL injection

5/22/2026 - nick decker | refactor
ADDED
- `mapRowToVideo(r)` — private helper extracting the repeated row→StoredVideo mapping from `getRandomVideos` and `listVideos`

CHANGED
- `getDb()` is now exported so backfill.ts can reuse the connection + migration instead of duplicating them
*/

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "../../data/summaries.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export type VideoMeta = {
  id: string;
  title: string;
  channel: string;
  publishedAt: string;
  description: string;
  thumbnailUrl?: string;
};

export type Summary = {
  oneLiner: string;
  keyTakeaways: string[];
  worthWatching: boolean;
  worthWatchingReason: string;
  shortSummary: string;
};

export type StoredVideo = VideoMeta &
  Summary & {
    summarizedAt: string;
  };

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      channel TEXT NOT NULL,
      published_at TEXT NOT NULL,
      description TEXT,
      one_liner TEXT NOT NULL,
      takeaways TEXT NOT NULL,
      worth_watching INTEGER NOT NULL,
      worth_watching_reason TEXT NOT NULL,
      summarized_at TEXT NOT NULL
    )
  `);
  for (const stmt of [
    "ALTER TABLE videos ADD COLUMN thumbnail_url TEXT",
    "ALTER TABLE videos ADD COLUMN short_summary TEXT",
  ]) {
    try { _db.exec(stmt); } catch {}
  }
  return _db;
}

export function isAlreadySummarized(videoId: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT id FROM videos WHERE id = ?").get(videoId);
  return row !== undefined;
}

export function saveVideo(video: VideoMeta, summary: Summary): void {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO videos
      (id, title, channel, published_at, description, thumbnail_url, one_liner, short_summary, takeaways, worth_watching, worth_watching_reason, summarized_at)
    VALUES
      (@id, @title, @channel, @publishedAt, @description, @thumbnailUrl, @oneLiner, @shortSummary, @takeaways, @worthWatching, @worthWatchingReason, @summarizedAt)
  `).run({
    id: video.id,
    title: video.title,
    channel: video.channel,
    publishedAt: video.publishedAt,
    description: video.description,
    thumbnailUrl: video.thumbnailUrl ?? null,
    oneLiner: summary.oneLiner,
    shortSummary: summary.shortSummary,
    takeaways: JSON.stringify(summary.keyTakeaways),
    worthWatching: summary.worthWatching ? 1 : 0,
    worthWatchingReason: summary.worthWatchingReason,
    summarizedAt: new Date().toISOString(),
  });
}

export function getDbStats(): { path: string; rowCount: number } {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as count FROM videos").get() as { count: number };
  return { path: DB_PATH, rowCount: row.count };
}

function mapRowToVideo(r: Record<string, unknown>): StoredVideo {
  return {
    id: r.id as string,
    title: r.title as string,
    channel: r.channel as string,
    publishedAt: r.published_at as string,
    description: r.description as string,
    thumbnailUrl: (r.thumbnail_url as string | null) ?? undefined,
    oneLiner: r.one_liner as string,
    shortSummary: (r.short_summary as string | null) ?? "",
    keyTakeaways: JSON.parse(r.takeaways as string) as string[],
    worthWatching: r.worth_watching === 1,
    worthWatchingReason: r.worth_watching_reason as string,
    summarizedAt: r.summarized_at as string,
  };
}

export function getRandomVideos(n = 5): StoredVideo[] {
  return (getDb().prepare("SELECT * FROM videos ORDER BY RANDOM() LIMIT ?").all(n) as Record<string, unknown>[]).map(mapRowToVideo);
}

const UPDATEABLE_COLUMNS = [
  "title", "channel", "description",
  "thumbnail_url", "one_liner", "short_summary", "worth_watching_reason",
] as const;

type UpdateableColumn = typeof UPDATEABLE_COLUMNS[number];

export function updateVideoColumn(id: string, column: UpdateableColumn, value: string | null): void {
  const db = getDb();
  db.prepare(`UPDATE videos SET ${column} = ? WHERE id = ?`).run(value, id);
}

export function listVideos(limit = 20): StoredVideo[] {
  return (getDb().prepare("SELECT * FROM videos ORDER BY summarized_at DESC LIMIT ?").all(limit) as Record<string, unknown>[]).map(mapRowToVideo);
}
