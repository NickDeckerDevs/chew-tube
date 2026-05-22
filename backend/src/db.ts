/*
5/22/2026 - nick decker | verdict algorithm v2
ADDED
- `verdict TEXT` column — "watch" | "conditional" | "skip" (3-tier, replaces binary worth_watching semantically)
- `verdict_detail TEXT` column — nuanced reason; for conditional: "watch if X, skip if Y"
- `top_comments TEXT` column — JSON array of {author, text, likes} from YouTube
- `clickbait INTEGER` + `clickbait_reason TEXT` columns — title-vs-transcript match signal
- `getVideosByIds(ids)` — fetches specific videos by ID list (used by rescore + control set scripts)

CHANGED
- `Summary` type updated with new fields: verdict, verdictDetail, clickbait, clickbaitReason, topComments
- `StoredVideo` picks up new fields through Summary
- `saveVideo` persists all new columns
- `mapRowToVideo` maps all new columns
- `UPDATEABLE_COLUMNS` extended with new columns

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

export type TopComment = {
  author: string;
  text: string;
  likes: number;
};

export type Summary = {
  oneLiner: string;
  keyTakeaways: string[];
  worthWatching: boolean;
  worthWatchingReason: string;
  shortSummary: string;
  // v2 verdict fields — null when scored with old algorithm
  verdict: "watch" | "conditional" | "skip" | null;
  verdictDetail: string | null;
  clickbait: boolean | null;
  clickbaitReason: string | null;
  topComments: TopComment[] | null;
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
    "ALTER TABLE videos ADD COLUMN verdict TEXT",
    "ALTER TABLE videos ADD COLUMN verdict_detail TEXT",
    "ALTER TABLE videos ADD COLUMN top_comments TEXT",
    "ALTER TABLE videos ADD COLUMN clickbait INTEGER",
    "ALTER TABLE videos ADD COLUMN clickbait_reason TEXT",
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
      (id, title, channel, published_at, description, thumbnail_url, one_liner, short_summary,
       takeaways, worth_watching, worth_watching_reason,
       verdict, verdict_detail, top_comments, clickbait, clickbait_reason,
       summarized_at)
    VALUES
      (@id, @title, @channel, @publishedAt, @description, @thumbnailUrl, @oneLiner, @shortSummary,
       @takeaways, @worthWatching, @worthWatchingReason,
       @verdict, @verdictDetail, @topComments, @clickbait, @clickbaitReason,
       @summarizedAt)
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
    verdict: summary.verdict ?? null,
    verdictDetail: summary.verdictDetail ?? null,
    topComments: summary.topComments ? JSON.stringify(summary.topComments) : null,
    clickbait: summary.clickbait === null ? null : (summary.clickbait ? 1 : 0),
    clickbaitReason: summary.clickbaitReason ?? null,
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
    verdict: (r.verdict as "watch" | "conditional" | "skip" | null) ?? null,
    verdictDetail: (r.verdict_detail as string | null) ?? null,
    topComments: r.top_comments ? JSON.parse(r.top_comments as string) as TopComment[] : null,
    clickbait: r.clickbait === null || r.clickbait === undefined ? null : r.clickbait === 1,
    clickbaitReason: (r.clickbait_reason as string | null) ?? null,
    summarizedAt: r.summarized_at as string,
  };
}

export function getRandomVideos(n = 5): StoredVideo[] {
  return (getDb().prepare("SELECT * FROM videos ORDER BY RANDOM() LIMIT ?").all(n) as Record<string, unknown>[]).map(mapRowToVideo);
}

const UPDATEABLE_COLUMNS = [
  "title", "channel", "description",
  "thumbnail_url", "one_liner", "short_summary", "worth_watching_reason",
  "verdict", "verdict_detail", "top_comments", "clickbait", "clickbait_reason",
] as const;

type UpdateableColumn = typeof UPDATEABLE_COLUMNS[number];

export function updateVideoColumn(id: string, column: UpdateableColumn, value: string | null): void {
  const db = getDb();
  db.prepare(`UPDATE videos SET ${column} = ? WHERE id = ?`).run(value, id);
}

export function listVideos(limit = 20): StoredVideo[] {
  return (getDb().prepare("SELECT * FROM videos ORDER BY summarized_at DESC LIMIT ?").all(limit) as Record<string, unknown>[]).map(mapRowToVideo);
}

export function getVideosByIds(ids: string[]): StoredVideo[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return (getDb().prepare(`SELECT * FROM videos WHERE id IN (${placeholders})`).all(...ids) as Record<string, unknown>[]).map(mapRowToVideo);
}
