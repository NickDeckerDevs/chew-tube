/*
5/23/2026 - nick decker | queue producer
ADDED
- Fetches videos from all algo-test sources (trending, categories, keyword searches)
- Gets transcripts for each video; skips Shorts/no-transcript videos
- Inserts transcribable videos into the queue table (INSERT OR IGNORE — idempotent)
- Skips videos already in the videos table (already scored)
- No Claude calls — runs in seconds per source
- Run via `npm run queue-fill [test-name]`
*/

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getTrending, searchVideos } from "./youtube.js";
import { getTranscript } from "./transcript.js";
import { isAlreadySummarized, enqueueVideo, getQueueStats } from "./db.js";
import type { VideoMeta } from "./db.js";
import { runScript } from "./utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const YOUTUBE_CATEGORIES: Record<string, string> = {
  "1":  "Film & Animation",
  "2":  "Autos & Vehicles",
  "10": "Music",
  "15": "Pets & Animals",
  "17": "Sports",
  "19": "Travel & Events",
  "20": "Gaming",
  "22": "People & Blogs",
  "23": "Comedy",
  "24": "Entertainment",
  "25": "News & Politics",
  "26": "Howto & Style",
  "27": "Education",
  "28": "Science & Technology",
  "29": "Nonprofits & Activism",
};

const SEARCH_SOURCES = [
  { label: "AI coding tools",     query: "AI coding tools developers 2026" },
  { label: "Soccer training",     query: "soccer drills training youth" },
  { label: "Quick dinner recipes", query: "quick weeknight dinner recipe" },
  { label: "Indie game reviews",  query: "indie game review 2026" },
  { label: "Music festivals",     query: "music festival highlights 2026" },
  { label: "Knitting tutorials",  query: "beginner knitting tutorial" },
  { label: "Car restoration",     query: "classic car restoration project" },
  { label: "News commentary",     query: "political news commentary this week" },
];

async function fillSource(
  label: string,
  videos: VideoMeta[],
  sourceType: string,
  channelLabel?: string
): Promise<{ queued: number; skipped: number; noTranscript: number }> {
  let queued = 0, skipped = 0, noTranscript = 0;

  for (const video of videos) {
    if (!video.id) continue;
    if (isAlreadySummarized(video.id)) { skipped++; process.stdout.write("."); continue; }

    const result = await getTranscript(video.id);
    if (!result.ok) { noTranscript++; process.stdout.write("_"); continue; }

    enqueueVideo({
      id: video.id,
      title: video.title,
      channel: video.channel,
      description: video.description ?? "",
      thumbnailUrl: video.thumbnailUrl,
      publishedAt: video.publishedAt ?? "",
      transcript: result.text,
      chunked: result.chunked,
      sourceType,
      sourceLabel: label,
      channelLabel,
    });
    queued++;
    process.stdout.write("+");
  }

  return { queued, skipped, noTranscript };
}

async function main(): Promise<void> {
  const testName = process.argv[2] ?? "skip-rate-baseline";
  const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../config.json"), "utf-8")
  ) as { settings: { categoryPreferences?: Record<string, number> } };
  const prefs = config.settings.categoryPreferences ?? {};

  console.log(`Queue fill — test: "${testName}"`);
  console.log(`Legend: + queued  . already scored  _ no transcript\n`);

  let totalQueued = 0;

  // Overall trending
  process.stdout.write(`[US Trending — All] `);
  try {
    const videos = await getTrending(50, "US");
    const r = await fillSource("US Trending — All", videos, "topic");
    totalQueued += r.queued;
    console.log(` → ${r.queued} queued, ${r.skipped} scored, ${r.noTranscript} no transcript`);
  } catch (err) { console.log(` skipped — ${(err as Error).message}`); }

  // Per-category trending
  for (const [id, name] of Object.entries(YOUTUBE_CATEGORIES).sort(([,a],[,b]) => a.localeCompare(b))) {
    const label = `Trending — ${name}`;
    process.stdout.write(`[${label}] (${prefs[id] ?? 3}★) `);
    try {
      const videos = await getTrending(50, "US", id);
      const r = await fillSource(label, videos, "topic");
      totalQueued += r.queued;
      console.log(` → ${r.queued} queued, ${r.skipped} scored, ${r.noTranscript} no transcript`);
    } catch (err) { console.log(` skipped — ${(err as Error).message}`); }
  }

  // Keyword searches
  for (const src of SEARCH_SOURCES) {
    process.stdout.write(`[${src.label}] `);
    try {
      const videos = await searchVideos(src.query, 50);
      const r = await fillSource(src.label, videos, "topic");
      totalQueued += r.queued;
      console.log(` → ${r.queued} queued, ${r.skipped} scored, ${r.noTranscript} no transcript`);
    } catch (err) { console.log(` skipped — ${(err as Error).message}`); }
  }

  const stats = getQueueStats();
  console.log(`\nDone. ${totalQueued} new items queued.`);
  console.log(`Queue: pending=${stats.pending ?? 0}  done=${stats.done ?? 0}  failed=${stats.failed ?? 0}`);
  console.log(`\nRun 'npm run queue-work ${testName}' to process.`);
}

runScript(main);
