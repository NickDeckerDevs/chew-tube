/*
5/24/2026 - nick decker | --log mode writes to file
CHANGED
- `log()` now writes to both stdout and a dated log file under `data/logs/`
- Log file path: `data/logs/YYYY-MM-DD-HHMMSS.log` — new file per run
- `data/logs/` directory created automatically if it doesn't exist

5/24/2026 - nick decker | --log mode
ADDED
- `LOG` flag — activated by passing `--log` as a CLI argument
- `log()` helper — writes only when LOG is set
- `estTimestamp()` helper — formats a Date as "MM DD YYYY HH MM SS EST"
- `processVideo` now returns `{ stored, gotTranscript }` so callers can track per-source stats
- Per-source log block when LOG is set:
    Starting run MM DD YYYY HH MM SS EST
    [channel/topic label]
      Queried: <label or topic string>
      Last video published: <publishedAt of last item in result set>
      Total returned: N
      In last 24h: N
      With transcripts: N
      Added to email: N

5/23/2026 - nick decker | split score into raw + penalty
CHANGED
- `processVideo()` destructures `scoreRaw` and `scorePenalty` from `computeScore` and patches both onto summary

5/23/2026 - nick decker | integer scorer
CHANGED
- Imports `computeScore` from scorer.ts
- `processVideo()` calls `computeScore` after summarization and patches `score` + `scoreBreakdown` onto summary before `saveVideo`

5/23/2026 - nick decker | category preference signal
CHANGED
- `DigestConfig.settings` type extended with `categoryPreferences?: Record<string, number>`
- `processVideo()` accepts optional `categoryScore` and passes it to `summarize()`
- Channel and topic loops resolve `categoryPreferences[video.categoryId]` before calling `processVideo()`

5/23/2026 - nick decker | category signals
CHANGED
- Imports `getVideoSignals` from youtube.ts
- After fetching playlist videos, calls `getVideoSignals` on the same IDs as `getVideoDurations` (both use the same ID list) and patches `categoryId` and `topicCategories` onto each VideoMeta before processing
- After fetching topic search videos, calls `getVideoSignals` on those IDs and patches signals before processing

5/23/2026 - nick decker | uploads playlist ID enforcement + hideSkipped
CHANGED
- Removed runtime `getUploadsPlaylistId()` call — now uses `ch.uploadsPlaylistId` directly from config
- `ChannelEntry` type now requires `uploadsPlaylistId` field (non-optional)
- Throws a clear error if `uploadsPlaylistId` is missing (mandatory, no fallback)
- `hideSkipped` read from `config.settings`, passed to `sendDigestEmail`
- `DigestConfig.settings` type updated with `hideSkipped?: boolean`

5/22/2026 - nick decker | quota optimization
CHANGED
- Channel video fetching switched from search.list (100 units/channel) to uploads playlist
  via getUploadsPlaylistId + getPlaylistVideos (2 units/channel) — ~98% quota reduction
  for channel fetches; search.list kept as fallback if uploads playlist unavailable

5/22/2026 - nick decker | verdict algorithm v2
CHANGED
- `DigestConfig.settings` now includes optional `persona` string — passed to `summarize()`
- `processVideo()` now accepts `persona` and `sourceType` ("channel" | "topic") — both passed to summarize()
- After summarization, fetches top 2 comments via `getTopComments()` and patches the summary before saving
- Comments stored as JSON in `top_comments` DB column via `updateVideoColumn`

5/22/2026 - nick decker | phase development
ADDED
- Automated digest runner that reads `config.json` and runs the video pipeline for each configured channel and topic
- 24-hour publish cutoff filter — only processes videos published since the last run
- Collects newly saved `StoredVideo[]` in memory; triggers `sendDigestEmail` when at least one new video was processed
- Per-video error isolation: transcript failures and DB errors skip the video without stopping the run
*/

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getPlaylistVideos, searchVideos, resolveHandle, getTopComments, getVideoDurations, isShort, getVideoSignals } from "./youtube.js";
import { getTranscript } from "./transcript.js";
import { summarize } from "./summarizer.js";
import type { SourceType } from "./summarizer.js";
import { isAlreadySummarized, saveVideo } from "./db.js";
import type { VideoMeta, StoredVideo } from "./db.js";
import { sendDigestEmail, sendLogEmail } from "./mailer.js";
import { computeScore } from "./scorer.js";

const LOG = process.argv.includes("--log");
const logLines: string[] = [];

function log(msg: string) {
  if (!LOG) return;
  console.log(msg);
  logLines.push(msg);
}

function estTimestamp(d: Date): string {
  const s = d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "2-digit", day: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  // "05/24/2026, 08:45:30" → "05 24 2026 08 45 30 EST"
  return s.replace(/\//g, " ").replace(", ", " ").replace(/:/g, " ") + " EST";
}

type ChannelEntry = { id?: string; uploadsPlaylistId: string; handle?: string; label: string };
type DigestConfig = {
  channels: ChannelEntry[];
  topics: string[];
  settings: { videosPerChannel: number; videosPerTopic: number; region: string; persona?: string; hideSkipped?: boolean; categoryPreferences?: Record<string, number> };
};

type ProcessResult = { stored: StoredVideo | null; gotTranscript: boolean };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../config.json"), "utf-8")
) as DigestConfig;

const CUTOFF = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const persona = config.settings.persona ?? "a general viewer";
const hideSkipped = config.settings.hideSkipped ?? false;

async function processVideo(
  video: VideoMeta,
  sourceType: SourceType,
  channelLabel?: string,
  categoryScore?: number
): Promise<ProcessResult> {
  if (!video.id) return { stored: null, gotTranscript: false };

  if (isAlreadySummarized(video.id)) {
    console.log(`  [skip] already in DB: ${video.title.slice(0, 60)}`);
    return { stored: null, gotTranscript: false };
  }

  process.stdout.write(`  Transcribing: ${video.title.slice(0, 60)}...`);
  const result = await getTranscript(video.id);
  if (!result.ok) {
    console.log(` no transcript (${result.reason})`);
    return { stored: null, gotTranscript: false };
  }
  console.log(` ok (${result.estimatedTokens.toLocaleString()} tokens)`);

  process.stdout.write(`  Summarizing...`);
  const summary = await summarize(video.title, result.text, result.chunked, persona, sourceType, channelLabel, categoryScore);
  console.log(" done");

  const { score, scoreRaw, scorePenalty, breakdown } = computeScore(summary, sourceType, categoryScore ?? 3);
  summary.score = score;
  summary.scoreRaw = scoreRaw;
  summary.scorePenalty = scorePenalty;
  summary.scoreBreakdown = breakdown;

  process.stdout.write(`  Fetching comments...`);
  const comments = await getTopComments(video.id, 2);
  summary.topComments = comments.length > 0 ? comments : null;
  console.log(comments.length > 0 ? ` ${comments.length} fetched` : " none available");

  try {
    saveVideo(video, summary, sourceType);
  } catch (err) {
    console.error(`  [db error] ${(err as Error).message}`);
    return { stored: null, gotTranscript: true };
  }

  return { stored: { ...video, ...summary, summarizedAt: new Date().toISOString() }, gotTranscript: true };
}

async function main(): Promise<void> {
  const toEmail = process.env.DIGEST_TO_EMAIL;
  if (!toEmail) throw new Error("DIGEST_TO_EMAIL is not set");

  log(`Starting run ${estTimestamp(new Date())}`);
  console.log(`Digest run — cutoff: ${CUTOFF}`);
  console.log(`Persona: ${persona}\n`);
  const newVideos: StoredVideo[] = [];

  for (const ch of config.channels) {
    let channelId = ch.id;
    if (!channelId && ch.handle) {
      process.stdout.write(`Resolving ${ch.handle}...`);
      channelId = (await resolveHandle(ch.handle)) ?? undefined;
      if (!channelId) {
        console.error(` could not resolve — skipping`);
        continue;
      }
      console.log(` ${channelId}`);
    }
    if (!channelId) continue;

    console.log(`\nChannel: ${ch.label}`);
    if (!ch.uploadsPlaylistId) throw new Error(`uploadsPlaylistId missing for channel "${ch.label}" — run build-persona to resolve`);
    const videos = await getPlaylistVideos(ch.uploadsPlaylistId, config.settings.videosPerChannel);
    const fresh = videos.filter((v) => v.publishedAt >= CUTOFF);
    const freshIds = fresh.map((v) => v.id).filter(Boolean) as string[];
    const [durations, signals] = await Promise.all([getVideoDurations(freshIds), getVideoSignals(freshIds)]);
    for (const v of fresh) { if (v.id && signals[v.id]) { v.categoryId = signals[v.id].categoryId; v.topicCategories = signals[v.id].topicCategories; } }
    const watchable = fresh.filter((v) => !v.id || !durations[v.id] || !isShort(durations[v.id]));
    console.log(`  ${videos.length} fetched, ${fresh.length} in last 24h, ${fresh.length - watchable.length} shorts filtered`);

    const categoryPrefs = config.settings.categoryPreferences ?? {};
    let transcripts = 0, added = 0;
    for (const video of watchable) {
      const categoryScore = video.categoryId ? categoryPrefs[video.categoryId] : undefined;
      const { stored, gotTranscript } = await processVideo(video, "channel", ch.label, categoryScore);
      if (gotTranscript) transcripts++;
      if (stored) { newVideos.push(stored); added++; }
    }

    const lastVideo = videos[videos.length - 1];
    log(`\nChannel: ${ch.label}`);
    log(`  Queried: ${ch.label} uploads playlist`);
    log(`  Last video published: ${lastVideo ? estTimestamp(new Date(lastVideo.publishedAt)) : "n/a"}`);
    log(`  Total returned: ${videos.length}`);
    log(`  In last 24h: ${fresh.length}`);
    log(`  With transcripts: ${transcripts}`);
    log(`  Added to email: ${added}`);
  }

  for (const topic of config.topics) {
    console.log(`\nTopic: "${topic}"`);
    const videos = await searchVideos(topic, config.settings.videosPerTopic, CUTOFF);
    const fresh = videos.filter((v) => v.publishedAt >= CUTOFF);
    const freshIds = fresh.map((v) => v.id).filter(Boolean) as string[];
    const signals = await getVideoSignals(freshIds);
    for (const v of fresh) { if (v.id && signals[v.id]) { v.categoryId = signals[v.id].categoryId; v.topicCategories = signals[v.id].topicCategories; } }
    console.log(`  ${videos.length} fetched, ${fresh.length} published in last 24h`);

    const categoryPrefs = config.settings.categoryPreferences ?? {};
    let transcripts = 0, added = 0;
    for (const video of fresh) {
      const categoryScore = video.categoryId ? categoryPrefs[video.categoryId] : undefined;
      const { stored, gotTranscript } = await processVideo(video, "topic", undefined, categoryScore);
      if (gotTranscript) transcripts++;
      if (stored) { newVideos.push(stored); added++; }
    }

    const lastVideo = videos[videos.length - 1];
    log(`\nTopic: "${topic}"`);
    log(`  Queried: "${topic}"`);
    log(`  Last video published: ${lastVideo ? estTimestamp(new Date(lastVideo.publishedAt)) : "n/a"}`);
    log(`  Total returned: ${videos.length}`);
    log(`  In last 24h: ${fresh.length}`);
    log(`  With transcripts: ${transcripts}`);
    log(`  Added to email: ${added}`);
  }

  console.log(`\nDone. ${newVideos.length} new video(s) processed.`);

  if (newVideos.length === 0) {
    console.log("Nothing new — skipping email.");
    return;
  }

  console.log(`Sending digest to ${toEmail}...`);
  await sendDigestEmail(newVideos, toEmail, undefined, hideSkipped);
  console.log("Email sent.");

  const logEmail = process.env.DIGEST_LOG_EMAIL;
  if (LOG && logEmail) {
    console.log(`Sending log to ${logEmail}...`);
    await sendLogEmail(logLines, logEmail);
    console.log("Log email sent.");
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message ?? err);
  process.exit(1);
});
