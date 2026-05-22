import "dotenv/config";
import { getTrending, getChannelVideos, searchVideos } from "./youtube.js";
import { getTranscript } from "./transcript.js";
import { summarize } from "./summarizer.js";
import { isAlreadySummarized, saveVideo } from "./db.js";
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

function usage(): never {
  console.error(`Usage:
  npx tsx src/index.ts trending [--category <id>] [--n <count>]
  npx tsx src/index.ts channel <channelId> [--n <count>]
  npx tsx src/index.ts search <query> [--n <count>]

Category IDs (for trending): 28=Science&Tech  22=People&Blogs  24=Entertainment`);
  process.exit(1);
}

function parseArgs(): {
  mode: "trending" | "channel" | "search";
  target?: string;
  n: number;
  categoryId?: string;
} {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();

  const mode = args[0] as "trending" | "channel" | "search";
  if (!["trending", "channel", "search"].includes(mode)) usage();

  let target: string | undefined;
  if (mode === "channel" || mode === "search") {
    target = args[1];
    if (!target) usage();
  }

  let n = 5;
  let categoryId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--n" && args[i + 1]) n = parseInt(args[i + 1], 10);
    if (args[i] === "--category" && args[i + 1]) categoryId = args[i + 1];
  }

  return { mode, target, n, categoryId };
}

async function fetchVideos(opts: ReturnType<typeof parseArgs>): Promise<VideoMeta[]> {
  switch (opts.mode) {
    case "trending":
      return getTrending(opts.n, "US", opts.categoryId);
    case "channel":
      return getChannelVideos(opts.target!, opts.n);
    case "search":
      return searchVideos(opts.target!, opts.n);
  }
}

function printSummary(video: VideoMeta, summary: {
  oneLiner: string;
  keyTakeaways: string[];
  worthWatching: boolean;
  worthWatchingReason: string;
}): void {
  const verdict = summary.worthWatching
    ? `${ANSI.green}✓ Worth watching${ANSI.reset}`
    : `${ANSI.yellow}✗ Skip it${ANSI.reset}`;

  console.log(`\n${ANSI.bold}${ANSI.cyan}${video.title}${ANSI.reset}`);
  console.log(`${ANSI.dim}${video.channel} · https://youtube.com/watch?v=${video.id}${ANSI.reset}`);
  console.log(`\n${summary.oneLiner}\n`);
  console.log(`${ANSI.bold}Key takeaways:${ANSI.reset}`);
  for (const pt of summary.keyTakeaways) {
    console.log(`  • ${pt}`);
  }
  console.log(`\n${verdict} — ${summary.worthWatchingReason}`);
  console.log(`${ANSI.dim}${"─".repeat(60)}${ANSI.reset}`);
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const videos = await fetchVideos(opts);

  if (videos.length === 0) {
    console.error("No videos returned. Check your YOUTUBE_API_KEY and try again.");
    process.exit(1);
  }

  console.log(`\nFetched ${videos.length} video(s). Processing...\n`);

  let processed = 0;
  let skippedNoTranscript = 0;
  let skippedAlreadyDone = 0;

  for (const video of videos) {
    if (!video.id) continue;

    if (isAlreadySummarized(video.id)) {
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

    saveVideo(video, summary);
    printSummary(video, summary);
    processed++;
  }

  console.log(
    `\nDone. ${processed} summarized, ${skippedAlreadyDone} already in DB, ${skippedNoTranscript} skipped (no transcript).`
  );
}

main().catch((err) => {
  console.error(`${ANSI.red}Fatal:${ANSI.reset}`, err.message ?? err);
  process.exit(1);
});
