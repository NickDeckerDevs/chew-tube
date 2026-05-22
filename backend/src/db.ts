import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "../../data/summaries.db");

export type VideoMeta = {
  id: string;
  title: string;
  channel: string;
  publishedAt: string;
  description: string;
};

export type Summary = {
  oneLiner: string;
  keyTakeaways: string[];
  worthWatching: boolean;
  worthWatchingReason: string;
};

export type StoredVideo = VideoMeta &
  Summary & {
    summarizedAt: string;
  };

let _db: Database.Database | null = null;

function getDb(): Database.Database {
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
      (id, title, channel, published_at, description, one_liner, takeaways, worth_watching, worth_watching_reason, summarized_at)
    VALUES
      (@id, @title, @channel, @publishedAt, @description, @oneLiner, @takeaways, @worthWatching, @worthWatchingReason, @summarizedAt)
  `).run({
    id: video.id,
    title: video.title,
    channel: video.channel,
    publishedAt: video.publishedAt,
    description: video.description,
    oneLiner: summary.oneLiner,
    takeaways: JSON.stringify(summary.keyTakeaways),
    worthWatching: summary.worthWatching ? 1 : 0,
    worthWatchingReason: summary.worthWatchingReason,
    summarizedAt: new Date().toISOString(),
  });
}

export function listVideos(limit = 20): StoredVideo[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM videos ORDER BY summarized_at DESC LIMIT ?")
    .all(limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    channel: r.channel as string,
    publishedAt: r.published_at as string,
    description: r.description as string,
    oneLiner: r.one_liner as string,
    keyTakeaways: JSON.parse(r.takeaways as string) as string[],
    worthWatching: r.worth_watching === 1,
    worthWatchingReason: r.worth_watching_reason as string,
    summarizedAt: r.summarized_at as string,
  }));
}
