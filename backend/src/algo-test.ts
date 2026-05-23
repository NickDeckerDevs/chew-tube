/*
5/23/2026 - nick decker | category signals
CHANGED
- Imports `getVideoSignals` from youtube.ts
- After fetching videos for each source, calls `getVideoSignals` and patches `categoryId` and `topicCategories` onto each `VideoMeta` before processing

5/23/2026 - nick decker | algo test runner
ADDED
- Fetches 50 videos from 24 sources: all 15 YouTube category trending feeds, overall trending, and 8 keyword searches
- Runs verdict pipeline (transcript + summarize) on each video
- Saves dated JSON results to data/results/ and updates manifest.json
- Run via `npm run algo-test`
*/

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getTrending, searchVideos, getTopComments, getVideoSignals } from "./youtube.js";
import { getTranscript } from "./transcript.js";
import { summarize } from "./summarizer.js";
import { isAlreadySummarized, saveVideo, getVideosByIds } from "./db.js";
import type { VideoMeta } from "./db.js";
import { runScript } from "./utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, "../../data/results");
const MANIFEST_PATH = path.join(RESULTS_DIR, "manifest.json");

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
  { label: "Soccer training",      query: "soccer drills training youth" },
  { label: "Quick dinner recipes", query: "quick weeknight dinner recipe" },
  { label: "Indie game reviews",   query: "indie game review 2026" },
  { label: "Music festivals",      query: "music festival highlights 2026" },
  { label: "Knitting tutorials",   query: "beginner knitting tutorial" },
  { label: "Car restoration",      query: "classic car restoration project" },
  { label: "News commentary",      query: "political news commentary this week" },
];

type SourceDef =
  | { type: "trending";          label: string; interestScore: number }
  | { type: "trending-category"; label: string; interestScore: number; categoryId: string; categoryName: string }
  | { type: "search";            label: string; interestScore: number; query: string };

type VideoSummary = {
  id: string;
  title: string;
  channel: string;
  verdict: string | null;
  verdictDetail: string | null;
  clickbait: boolean | null;
};

type SourceResult = {
  label: string;
  type: string;
  query?: string;
  categoryId?: string;
  categoryName?: string;
  interestScore: number;
  fetched: number;
  noTranscript: number;
  processed: number;
  verdicts: { watch: number; conditional: number; skip: number };
  skipRate: number;
  videos: VideoSummary[];
};

type TestResult = {
  testName: string;
  runAt: string;
  persona: string;
  sources: SourceResult[];
  totals: {
    fetched: number;
    noTranscript: number;
    processed: number;
    watch: number;
    conditional: number;
    skip: number;
    skipRate: number;
  };
};

type ManifestEntry = { file: string; name: string; runAt: string };

function loadManifest(): ManifestEntry[] {
  try { return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8")); }
  catch { return []; }
}

function saveManifest(entries: ManifestEntry[]): void {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(entries, null, 2));
}

async function processSource(src: SourceDef, persona: string): Promise<SourceResult> {
  console.log(`\n[${src.label}] (interest: ${src.interestScore}/5)`);

  let videos: VideoMeta[];
  try {
    if (src.type === "trending") videos = await getTrending(50, "US");
    else if (src.type === "trending-category") videos = await getTrending(50, "US", src.categoryId);
    else videos = await searchVideos(src.query, 50);
  } catch (err) {
    console.log(`  Skipped — API error: ${(err as Error).message}`);
    return { label: src.label, type: src.type, interestScore: src.interestScore, fetched: 0, noTranscript: 0, processed: 0, verdicts: { watch: 0, conditional: 0, skip: 0 }, skipRate: 0, videos: [] };
  }
  console.log(`  Fetched ${videos.length}`);

  if (src.type === "search") {
    const ids = videos.map((v) => v.id).filter(Boolean) as string[];
    const signals = await getVideoSignals(ids);
    for (const v of videos) { if (v.id && signals[v.id]) { v.categoryId = signals[v.id].categoryId; v.topicCategories = signals[v.id].topicCategories; } }
  }

  const result: SourceResult = {
    label: src.label,
    type: src.type,
    interestScore: src.interestScore,
    ...(src.type === "search" ? { query: src.query } : {}),
    ...(src.type === "trending-category" ? { categoryId: src.categoryId, categoryName: src.categoryName } : {}),
    fetched: videos.length,
    noTranscript: 0,
    processed: 0,
    verdicts: { watch: 0, conditional: 0, skip: 0 },
    skipRate: 0,
    videos: [],
  };

  for (const video of videos) {
    if (!video.id) continue;

    if (isAlreadySummarized(video.id)) {
      const [existing] = getVideosByIds([video.id]);
      if (existing?.verdict) {
        const v = existing.verdict as "watch" | "conditional" | "skip";
        if (v in result.verdicts) result.verdicts[v]++;
        result.processed++;
        result.videos.push({ id: video.id, title: video.title, channel: video.channel, verdict: existing.verdict, verdictDetail: existing.verdictDetail ?? null, clickbait: existing.clickbait ?? null });
        process.stdout.write(".");
        continue;
      }
    }

    const transcript = await getTranscript(video.id);
    if (!transcript.ok) { result.noTranscript++; process.stdout.write("_"); continue; }

    const summary = await summarize(video.title, transcript.text, transcript.chunked, persona, "topic");
    const comments = await getTopComments(video.id, 2);
    summary.topComments = comments.length > 0 ? comments : null;

    if (!isAlreadySummarized(video.id)) {
      try { saveVideo(video, summary); } catch { /* dup */ }
    }

    const v = (summary.verdict ?? "skip") as "watch" | "conditional" | "skip";
    if (v in result.verdicts) result.verdicts[v]++;
    result.processed++;
    result.videos.push({ id: video.id, title: video.title, channel: video.channel, verdict: summary.verdict ?? null, verdictDetail: summary.verdictDetail ?? null, clickbait: summary.clickbait ?? null });
    process.stdout.write(v === "watch" ? "W" : v === "conditional" ? "C" : "S");
  }

  console.log();
  result.skipRate = result.processed > 0 ? result.verdicts.skip / result.processed : 0;
  return result;
}

async function main(): Promise<void> {
  const testName = process.argv[2] ?? "skip-rate-baseline";
  const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../config.json"), "utf-8")
  ) as { settings: { persona?: string; categoryPreferences?: Record<string, number> } };

  const persona = config.settings.persona ?? "a general viewer";
  const prefs = config.settings.categoryPreferences ?? {};

  const categorySources: SourceDef[] = Object.entries(YOUTUBE_CATEGORIES)
    .sort(([, a], [, b]) => a.localeCompare(b))
    .map(([id, name]) => ({
      type: "trending-category" as const,
      label: `Trending — ${name}`,
      categoryId: id,
      categoryName: name,
      interestScore: prefs[id] ?? 3,
    }));

  const searchSources: SourceDef[] = SEARCH_SOURCES.map((s) => ({
    type: "search" as const,
    label: s.label,
    query: s.query,
    interestScore: 3,
  }));

  const allSources: SourceDef[] = [
    { type: "trending", label: "US Trending — All", interestScore: 3 },
    ...categorySources,
    ...searchSources,
  ];

  console.log(`Algo test: "${testName}"`);
  console.log(`Persona: ${persona}`);
  console.log(`Sources: ${allSources.length} — Legend: W=watch C=conditional S=skip _=no transcript .=cached\n`);

  const sources: SourceResult[] = [];
  for (const src of allSources) {
    sources.push(await processSource(src, persona));
  }

  const totals = sources.reduce(
    (acc, s) => ({
      fetched: acc.fetched + s.fetched,
      noTranscript: acc.noTranscript + s.noTranscript,
      processed: acc.processed + s.processed,
      watch: acc.watch + s.verdicts.watch,
      conditional: acc.conditional + s.verdicts.conditional,
      skip: acc.skip + s.verdicts.skip,
      skipRate: 0,
    }),
    { fetched: 0, noTranscript: 0, processed: 0, watch: 0, conditional: 0, skip: 0, skipRate: 0 }
  );
  totals.skipRate = totals.processed > 0 ? totals.skip / totals.processed : 0;

  const result: TestResult = { testName, runAt: new Date().toISOString(), persona, sources, totals };

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const filename = `${date}-${testName}.json`;
  fs.writeFileSync(path.join(RESULTS_DIR, filename), JSON.stringify(result, null, 2));

  const manifest = loadManifest();
  const idx = manifest.findIndex((e) => e.file === filename);
  const entry: ManifestEntry = { file: filename, name: testName, runAt: result.runAt };
  if (idx >= 0) manifest[idx] = entry; else manifest.unshift(entry);
  saveManifest(manifest);

  console.log(`\n── Totals ──────────────────────────────`);
  console.log(`  Fetched:      ${totals.fetched}`);
  console.log(`  No transcript: ${totals.noTranscript}`);
  console.log(`  Processed:    ${totals.processed}`);
  console.log(`  Watch:        ${totals.watch}  (${pct(totals.watch, totals.processed)}%)`);
  console.log(`  Conditional:  ${totals.conditional}  (${pct(totals.conditional, totals.processed)}%)`);
  console.log(`  Skip:         ${totals.skip}  (${pct(totals.skip, totals.processed)}%)`);
  console.log(`\nSaved → data/results/${filename}`);
}

function pct(n: number, total: number): string {
  return total > 0 ? Math.round((n / total) * 100).toString() : "0";
}

runScript(main);
