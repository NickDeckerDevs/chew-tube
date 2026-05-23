/*
5/23/2026 - nick decker | queue table
ADDED
- `QueueItem` type — video + transcript + source metadata + status fields
- `queue` table in `getDb()` schema (created if not exists)
- `enqueueVideo(item)` — INSERT OR IGNORE so re-runs are idempotent
- `dequeueNext()` — atomic SELECT + UPDATE to 'processing' (crash-safe)
- `markQueueDone(id)` / `markQueueFailed(id, error)` — terminal status updates
- `getQueueStats()` — counts by status
- `resetStuckItems()` — resets 'processing' → 'pending' on worker startup
- `clearQueue()` — wipes all queue rows (test utility)

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

export type QueueItem = {
  id: string;
  title: string;
  channel: string;
  description: string;
  thumbnailUrl?: string;
  publishedAt: string;
  transcript: string;
  chunked: boolean;
  sourceType: string;
  sourceLabel: string;
  channelLabel?: string;
  queuedAt: string;
  status: "pending" | "processing" | "done" | "failed";
  error?: string;
};

export function getDb(): Database.Database {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS queue (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      channel       TEXT NOT NULL,
      description   TEXT,
      thumbnail_url TEXT,
      published_at  TEXT,
      transcript    TEXT NOT NULL,
      chunked       INTEGER NOT NULL DEFAULT 0,
      source_type   TEXT NOT NULL,
      source_label  TEXT NOT NULL DEFAULT '',
      channel_label TEXT,
      queued_at     TEXT NOT NULL DEFAULT (datetime('now')),
      status        TEXT NOT NULL DEFAULT 'pending',
      started_at    TEXT,
      completed_at  TEXT,
      error         TEXT
    )
  `);
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

// ── Queue functions ──────────────────────────────────────────────────────────

export function enqueueVideo(item: Omit<QueueItem, "queuedAt" | "status">): void {
  getDb().prepare(`
    INSERT OR IGNORE INTO queue
      (id, title, channel, description, thumbnail_url, published_at,
       transcript, chunked, source_type, source_label, channel_label)
    VALUES
      (@id, @title, @channel, @description, @thumbnailUrl, @publishedAt,
       @transcript, @chunked, @sourceType, @sourceLabel, @channelLabel)
  `).run({
    ...item,
    thumbnailUrl: item.thumbnailUrl ?? null,
    channelLabel: item.channelLabel ?? null,
    chunked: item.chunked ? 1 : 0,
  });
}

export function dequeueNext(): QueueItem | null {
  const db = getDb();
  const dequeue = db.transaction(() => {
    const row = db.prepare(
      "SELECT * FROM queue WHERE status = 'pending' ORDER BY queued_at LIMIT 1"
    ).get() as Record<string, unknown> | undefined;
    if (!row) return null;
    db.prepare(
      "UPDATE queue SET status = 'processing', started_at = datetime('now') WHERE id = ?"
    ).run(row.id);
    return row;
  });
  const row = dequeue() as Record<string, unknown> | null;
  if (!row) return null;
  return {
    id: row.id as string,
    title: row.title as string,
    channel: row.channel as string,
    description: (row.description as string) ?? "",
    thumbnailUrl: (row.thumbnail_url as string | null) ?? undefined,
    publishedAt: (row.published_at as string) ?? "",
    transcript: row.transcript as string,
    chunked: row.chunked === 1,
    sourceType: row.source_type as string,
    sourceLabel: row.source_label as string,
    channelLabel: (row.channel_label as string | null) ?? undefined,
    queuedAt: row.queued_at as string,
    status: "processing",
  };
}

export function markQueueDone(id: string): void {
  getDb().prepare(
    "UPDATE queue SET status = 'done', completed_at = datetime('now') WHERE id = ?"
  ).run(id);
}

export function markQueueFailed(id: string, error: string): void {
  getDb().prepare(
    "UPDATE queue SET status = 'failed', error = ?, completed_at = datetime('now') WHERE id = ?"
  ).run(error, id);
}

export function getQueueStats(): Record<string, number> {
  const rows = getDb().prepare(
    "SELECT status, COUNT(*) as count FROM queue GROUP BY status"
  ).all() as { status: string; count: number }[];
  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}

export function resetStuckItems(): number {
  const result = getDb().prepare(
    "UPDATE queue SET status = 'pending', started_at = NULL WHERE status = 'processing'"
  ).run();
  return result.changes;
}

export function clearQueue(): void {
  getDb().prepare("DELETE FROM queue").run();
}
