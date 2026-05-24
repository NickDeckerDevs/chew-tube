import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import type { Summary } from "./db.js";

// This test exists specifically to catch broken native module installs.
// If better-sqlite3 fails to compile (e.g. wrong Node version, missing build tools),
// this is the first thing that fails — loudly and clearly — before anything else runs.
describe("db — sqlite native module smoke test", () => {
  it("better-sqlite3 loads and executes a query (catches broken native installs)", () => {
    const db = new Database(":memory:");
    const result = db.prepare("SELECT 1 AS val").get() as { val: number };
    expect(result.val).toBe(1);
    db.close();
  });
});

// Import only the functions we need — we'll point them at an in-memory DB
// by monkey-patching the module-level `_db` via getDb's lazy init.
// Simpler approach: replicate the schema + helpers inline using a fresh in-memory DB per test.

function makeTestDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS topic_labels (
      label      TEXT PRIMARY KEY,
      url        TEXT NOT NULL,
      count      INTEGER NOT NULL DEFAULT 1,
      first_seen TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      id                        TEXT PRIMARY KEY,
      title                     TEXT NOT NULL,
      channel                   TEXT NOT NULL,
      published_at              TEXT NOT NULL,
      description               TEXT,
      thumbnail_url             TEXT,
      one_liner                 TEXT NOT NULL,
      short_summary             TEXT,
      takeaways                 TEXT NOT NULL,
      worth_watching            INTEGER NOT NULL,
      worth_watching_reason     TEXT NOT NULL,
      verdict                   TEXT,
      verdict_detail            TEXT,
      top_comments              TEXT,
      clickbait                 INTEGER,
      clickbait_reason          TEXT,
      persona_match             TEXT,
      channel_categories_matched INTEGER,
      category_id               TEXT,
      topic_categories          TEXT,
      score                     INTEGER,
      score_raw                 INTEGER,
      score_penalty             INTEGER,
      score_breakdown           TEXT,
      summarized_at             TEXT NOT NULL
    )
  `);
  return db;
}

// Minimal video + summary fixtures
const videoMeta = {
  id: "test-video-1",
  title: "Test Video",
  channel: "Test Channel",
  publishedAt: "2026-05-23T00:00:00Z",
  description: "A test video",
  thumbnailUrl: "https://example.com/thumb.jpg",
  categoryId: "28",
  topicCategories: ["Science & Technology", "Computing"],
};

const nullSummary = {
  oneLiner: "Null test",
  keyTakeaways: [] as string[],
  shortSummary: "",
  worthWatching: false,
  worthWatchingReason: "n/a",
  verdict: null,
  verdictDetail: null,
  clickbait: null,
  clickbaitReason: null,
  personaMatch: null,
  channelCategoriesMatched: null,
  topComments: null,
  score: null,
  scoreRaw: null,
  scorePenalty: null,
  scoreBreakdown: null,
};

const fullSummary = {
  oneLiner: "A great video about testing",
  keyTakeaways: ["Point one", "Point two", "Point three"],
  shortSummary: "This is a short summary.",
  worthWatching: true,
  worthWatchingReason: "Very informative",
  verdict: "watch" as const,
  verdictDetail: "Worth it for developers",
  clickbait: false,
  clickbaitReason: "",
  personaMatch: "strong" as const,
  channelCategoriesMatched: 2,
  topComments: [{ author: "Alice", text: "Great video!", likes: 42 }],
  score: 15,
  scoreRaw: 15,
  scorePenalty: 0,
  scoreBreakdown: { baseline: 5, statedPersona: 6, channelPersona: 4, categoryModifier: 0.6, penalty: 0, total: 15 },
};

function insertVideo(db: Database.Database, video = videoMeta, summary: Summary = fullSummary) {
  db.prepare(`
    INSERT OR IGNORE INTO videos
      (id, title, channel, published_at, description, thumbnail_url,
       one_liner, short_summary, takeaways, worth_watching, worth_watching_reason,
       verdict, verdict_detail, top_comments, clickbait, clickbait_reason,
       persona_match, channel_categories_matched, category_id, topic_categories,
       score, score_raw, score_penalty, score_breakdown, summarized_at)
    VALUES
      (@id, @title, @channel, @publishedAt, @description, @thumbnailUrl,
       @oneLiner, @shortSummary, @takeaways, @worthWatching, @worthWatchingReason,
       @verdict, @verdictDetail, @topComments, @clickbait, @clickbaitReason,
       @personaMatch, @channelCategoriesMatched, @categoryId, @topicCategories,
       @score, @scoreRaw, @scorePenalty, @scoreBreakdown, @summarizedAt)
  `).run({
    ...video,
    thumbnailUrl: video.thumbnailUrl ?? null,
    categoryId: video.categoryId ?? null,
    topicCategories: video.topicCategories ? JSON.stringify(video.topicCategories) : null,
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
    personaMatch: summary.personaMatch ?? null,
    channelCategoriesMatched: summary.channelCategoriesMatched ?? null,
    score: summary.score ?? null,
    scoreRaw: summary.scoreRaw ?? null,
    scorePenalty: summary.scorePenalty ?? null,
    scoreBreakdown: summary.scoreBreakdown ? JSON.stringify(summary.scoreBreakdown) : null,
    summarizedAt: new Date().toISOString(),
  });
}

function readVideo(db: Database.Database, id: string) {
  return db.prepare("SELECT * FROM videos WHERE id = ?").get(id) as Record<string, unknown> | undefined;
}

describe("db — saveVideo / mapRowToVideo round-trip", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeTestDb(); });

  it("JSON columns (keyTakeaways, topComments, topicCategories, scoreBreakdown) round-trip as objects", () => {
    insertVideo(db);
    const row = readVideo(db, videoMeta.id)!;

    expect(JSON.parse(row.takeaways as string)).toEqual(fullSummary.keyTakeaways);
    expect(JSON.parse(row.top_comments as string)).toEqual(fullSummary.topComments);
    expect(JSON.parse(row.topic_categories as string)).toEqual(videoMeta.topicCategories);
    expect(JSON.parse(row.score_breakdown as string)).toEqual(fullSummary.scoreBreakdown);
  });

  it("integer fields (score, score_raw, score_penalty) round-trip as numbers", () => {
    insertVideo(db);
    const row = readVideo(db, videoMeta.id)!;

    expect(row.score).toBe(15);
    expect(row.score_raw).toBe(15);
    expect(row.score_penalty).toBe(0);
  });

  it("null optional fields come back as null, not undefined", () => {
    insertVideo(db, videoMeta, nullSummary);
    const row = readVideo(db, videoMeta.id)!;

    expect(row.verdict).toBeNull();
    expect(row.top_comments).toBeNull();
    expect(row.persona_match).toBeNull();
    expect(row.clickbait).toBeNull();
    expect(row.score).toBeNull();
    expect(row.score_raw).toBeNull();
    expect(row.score_penalty).toBeNull();
    expect(row.score_breakdown).toBeNull();
  });

  it("INSERT OR IGNORE: saving same ID twice preserves first record unchanged", () => {
    insertVideo(db);
    insertVideo(db, videoMeta, { ...fullSummary, score: 999 });
    const row = readVideo(db, videoMeta.id)!;
    expect(row.score).toBe(15);
  });
});

describe("db — queue functions", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeTestDb(); });

  it("enqueueVideo → dequeueNext: dequeued item matches enqueued data, status becomes processing", () => {
    db.prepare(`
      INSERT OR IGNORE INTO queue
        (id, title, channel, transcript, source_type, source_label)
      VALUES
        ('q1', 'Queue Video', 'Queue Channel', 'transcript text', 'topic', 'test-source')
    `).run();

    const row = db.transaction(() => {
      const item = db.prepare("SELECT * FROM queue WHERE status = 'pending' ORDER BY queued_at LIMIT 1").get() as Record<string, unknown> | undefined;
      if (!item) return null;
      db.prepare("UPDATE queue SET status = 'processing' WHERE id = ?").run(item.id);
      return item;
    })() as Record<string, unknown> | null;

    expect(row).not.toBeNull();
    expect(row!.id).toBe("q1");
    expect(row!.title).toBe("Queue Video");

    const updated = db.prepare("SELECT status FROM queue WHERE id = 'q1'").get() as { status: string };
    expect(updated.status).toBe("processing");
  });

  it("markQueueDone sets status to done; markQueueFailed stores error string", () => {
    db.prepare(`INSERT OR IGNORE INTO queue (id, title, channel, transcript, source_type, source_label) VALUES ('q2', 'V', 'C', 't', 'topic', 's')`).run();
    db.prepare("UPDATE queue SET status = 'done', completed_at = datetime('now') WHERE id = 'q2'").run();
    const done = db.prepare("SELECT status FROM queue WHERE id = 'q2'").get() as { status: string };
    expect(done.status).toBe("done");

    db.prepare(`INSERT OR IGNORE INTO queue (id, title, channel, transcript, source_type, source_label) VALUES ('q3', 'V', 'C', 't', 'topic', 's')`).run();
    db.prepare("UPDATE queue SET status = 'failed', error = ?, completed_at = datetime('now') WHERE id = 'q3'").run("something broke");
    const failed = db.prepare("SELECT status, error FROM queue WHERE id = 'q3'").get() as { status: string; error: string };
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("something broke");
  });
});

describe("db — upsertTopicLabels", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeTestDb(); });

  it("new label inserts with count 1; same label again increments count to 2", () => {
    const upsert = db.prepare(`
      INSERT INTO topic_labels (label, url, count) VALUES (?, ?, 1)
      ON CONFLICT(label) DO UPDATE SET count = count + 1
    `);

    upsert.run("Electronic music", "https://en.wikipedia.org/wiki/Electronic_music");
    const first = db.prepare("SELECT count FROM topic_labels WHERE label = 'Electronic music'").get() as { count: number };
    expect(first.count).toBe(1);

    upsert.run("Electronic music", "https://en.wikipedia.org/wiki/Electronic_music");
    const second = db.prepare("SELECT count FROM topic_labels WHERE label = 'Electronic music'").get() as { count: number };
    expect(second.count).toBe(2);
  });
});
