/*
5/22/2026 - nick decker | phase 1 task work
ADDED
- `categories` mode: lists all assignable YouTube video categories
- `resolve` mode: looks up a channel ID from a @handle
- `playlist` mode: fetches videos from a playlist by ID or URL
- `--region` flag for `trending` and `categories` commands
- DB stats (path + row count) printed at startup
- DB error handling with per-video error counting

CHANGED
- `mode` type and `parseArgs` updated to include new modes
- `channel` mode auto-resolves @handle to channel ID before fetching
*/

import "dotenv/config";
import {
  getTrending,
  getChannelVideos,
  searchVideos,
  getCategories,
  resolveHandle,
  getPlaylistVideos,
  extractPlaylistId,
} from "./youtube.js";
import { getTranscript } from "./transcript.js";
import { summarize } from "./summarizer.js";
import { isAlreadySummarized, saveVideo, getDbStats } from "./db.js";
import type { VideoMeta } from "./db.js";

const ANSI = {
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
};

type Mode = "trending" | "channel" | "search" | "playlist" | "categories" | "resolve";

function usage(): never {
  console.error(`Usage:
  npx tsx src/index.ts trending [--category <id>] [--n <count>]
  npx tsx src/index.ts channel <channelId|@handle> [--n <count>]
  npx tsx src/index.ts search <query> [--n <count>]
  npx tsx src/index.ts playlist <playlistId|URL> [--n <count>]
  npx tsx src/index.ts categories [--region <code>]
  npx tsx src/index.ts resolve <@handle>`);
  process.exit(1);
}

function parseArgs(): {
  mode: Mode;
  target?: string;
  n: number;
  categoryId?: string;
  region: string;
} {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();

  const mode = args[0] as Mode;
  const validModes: Mode[] = ["trending", "channel", "search", "playlist", "categories", "resolve"];
  if (!validModes.includes(mode)) usage();

  let target: string | undefined;
  if (["channel", "search", "playlist", "resolve"].includes(mode)) {
    target = args[1];
    if (!target) usage();
  }

  let n = 5;
  let categoryId: string | undefined;
  let region = "US";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--n" && args[i + 1]) n = parseInt(args[i + 1], 10);
    if (args[i] === "--category" && args[i + 1]) categoryId = args[i + 1];
    if (args[i] === "--region" && args[i + 1]) region = args[i + 1];
  }

  return { mode, target, n, categoryId, region };
}

async function fetchVideos(opts: ReturnType<typeof parseArgs>): Promise<VideoMeta[]> {
  switch (opts.mode) {
    case "trending":
      return getTrending(opts.n, opts.region, opts.categoryId);
    case "channel": {
      let id = opts.target!;
      if (id.startsWith("@")) {
        process.stdout.write(`Resolving ${id}...`);
        const resolved = await resolveHandle(id);
        if (!resolved) {
          console.error(`\nCould not resolve handle ${id}. Check the handle and try again.`);
          process.exit(1);
        }
        console.log(` ${ANSI.dim}${resolved}${ANSI.reset}`);
        id = resolved;
      }
      return getChannelVideos(id, opts.n);
    }
    case "search":
      return searchVideos(opts.target!, opts.n);
    case "playlist":
      return getPlaylistVideos(extractPlaylistId(opts.target!), opts.n);
  }
  return [];
}

function printSummary(video: VideoMeta, summary: {
  oneLiner: string;
  shortSummary: string;
  keyTakeaways: string[];
  worthWatching: boolean;
  worthWatchingReason: string;
}): void {
  const verdict = summary.worthWatching
    ? `${ANSI.green}✓ Worth watching${ANSI.reset}`
    : `${ANSI.yellow}✗ Skip it${ANSI.reset}`;

  console.log(`\n${ANSI.bold}${ANSI.cyan}${video.title}${ANSI.reset}`);
  console.log(`${ANSI.dim}${video.channel} · https://youtube.com/watch?v=${video.id}${ANSI.reset}`);
  if (summary.shortSummary) console.log(`\n${summary.shortSummary}`);
  console.log(`\n${ANSI.dim}${summary.oneLiner}${ANSI.reset}\n`);
  console.log(`${ANSI.bold}Key takeaways:${ANSI.reset}`);
  for (const pt of summary.keyTakeaways) {
    console.log(`  • ${pt}`);
  }
  console.log(`\n${verdict} — ${summary.worthWatchingReason}`);
  console.log(`${ANSI.dim}${"─".repeat(60)}${ANSI.reset}`);
}

async function main(): Promise<void> {
  const opts = parseArgs();

  if (opts.mode === "categories") {
    const cats = await getCategories(opts.region);
    console.log(`\n${ANSI.bold}YouTube Video Categories (region: ${opts.region})${ANSI.reset}\n`);
    for (const cat of cats) {
      console.log(`  ${ANSI.cyan}${cat.id.padStart(3)}${ANSI.reset}  ${cat.title}`);
    }
    console.log();
    return;
  }

  if (opts.mode === "resolve") {
    const handle = opts.target!;
    process.stdout.write(`Resolving ${handle}...`);
    const id = await resolveHandle(handle);
    if (!id) {
      console.error(`\n${ANSI.red}Could not resolve handle ${handle}${ANSI.reset}`);
      process.exit(1);
    }
    console.log(`\n${ANSI.bold}${handle}${ANSI.reset}  →  ${ANSI.cyan}${id}${ANSI.reset}`);
    console.log(`${ANSI.dim}npx tsx src/index.ts channel ${id}${ANSI.reset}\n`);
    return;
  }

  const videos = await fetchVideos(opts);

  if (videos.length === 0) {
    console.error("No videos returned. Check your YOUTUBE_API_KEY and try again.");
    process.exit(1);
  }

  const dbStats = getDbStats();
  console.log(`${ANSI.dim}DB: ${dbStats.path} (${dbStats.rowCount} rows)${ANSI.reset}`);
  console.log(`\nFetched ${videos.length} video(s). Processing...\n`);

  let processed = 0;
  let skippedNoTranscript = 0;
  let skippedAlreadyDone = 0;
  let skippedDbError = 0;

  for (const video of videos) {
    if (!video.id) continue;

    let alreadyDone: boolean;
    try {
      alreadyDone = isAlreadySummarized(video.id);
    } catch (err) {
      console.error(`${ANSI.red}[db error] skipping ${video.title}: ${(err as Error).message}${ANSI.reset}`);
      skippedDbError++;
      continue;
    }

    if (alreadyDone) {
      console.log(`${ANSI.dim}[skip] already summarized: ${video.title}${ANSI.reset}`);
      skippedAlreadyDone++;
      continue;
    }

    process.stdout.write(`Transcribing: ${video.title.slice(0, 60)}...`);
    const result = await getTranscript(video.id);

    if (!result.ok) {
      console.log(` ${ANSI.red}✗ ${result.reason}${ANSI.reset}`);
      skippedNoTranscript++;
      continue;
    }

    const tokenNote = result.chunked
      ? ` (${result.estimatedTokens.toLocaleString()} tokens — using map-reduce)`
      : ` (${result.estimatedTokens.toLocaleString()} tokens)`;
    console.log(` ${ANSI.green}✓${ANSI.reset}${ANSI.dim}${tokenNote}${ANSI.reset}`);

    process.stdout.write(`Summarizing...`);
    const summary = await summarize(video.title, result.text, result.chunked);
    console.log(` ${ANSI.green}✓${ANSI.reset}`);

    try {
      saveVideo(video, summary);
      processed++;
    } catch (err) {
      console.error(`${ANSI.red}[db error] could not save ${video.title}: ${(err as Error).message}${ANSI.reset}`);
      skippedDbError++;
    }
    printSummary(video, summary);
  }

  const dbErrNote = skippedDbError > 0 ? `, ${skippedDbError} db errors` : "";
  console.log(
    `\nDone. ${processed} summarized, ${skippedAlreadyDone} already in DB, ${skippedNoTranscript} skipped (no transcript)${dbErrNote}.`
  );
}

main().catch((err) => {
  console.error(`${ANSI.red}Fatal:${ANSI.reset}`, err.message ?? err);
  process.exit(1);
});
