/*
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
import { getPlaylistVideos, searchVideos, resolveHandle, getTopComments, getVideoDurations, isShort } from "./youtube.js";
import { getTranscript } from "./transcript.js";
import { summarize } from "./summarizer.js";
import type { SourceType } from "./summarizer.js";
import { isAlreadySummarized, saveVideo, updateVideoColumn } from "./db.js";
import type { VideoMeta, StoredVideo } from "./db.js";
import { sendDigestEmail } from "./mailer.js";

type ChannelEntry = { id?: string; uploadsPlaylistId: string; handle?: string; label: string };
type DigestConfig = {
  channels: ChannelEntry[];
  topics: string[];
  settings: { videosPerChannel: number; videosPerTopic: number; region: string; persona?: string; hideSkipped?: boolean };
};

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
  channelLabel?: string
): Promise<StoredVideo | null> {
  if (!video.id) return null;

  if (isAlreadySummarized(video.id)) {
    console.log(`  [skip] already in DB: ${video.title.slice(0, 60)}`);
    return null;
  }

  process.stdout.write(`  Transcribing: ${video.title.slice(0, 60)}...`);
  const result = await getTranscript(video.id);
  if (!result.ok) {
    console.log(` no transcript (${result.reason})`);
    return null;
  }
  console.log(` ok (${result.estimatedTokens.toLocaleString()} tokens)`);

  process.stdout.write(`  Summarizing...`);
  const summary = await summarize(video.title, result.text, result.chunked, persona, sourceType, channelLabel);
  console.log(" done");

  process.stdout.write(`  Fetching comments...`);
  const comments = await getTopComments(video.id, 2);
  summary.topComments = comments.length > 0 ? comments : null;
  console.log(comments.length > 0 ? ` ${comments.length} fetched` : " none available");

  try {
    saveVideo(video, summary);
  } catch (err) {
    console.error(`  [db error] ${(err as Error).message}`);
    return null;
  }

  return { ...video, ...summary, summarizedAt: new Date().toISOString() };
}

async function main(): Promise<void> {
  const toEmail = process.env.DIGEST_TO_EMAIL;
  if (!toEmail) throw new Error("DIGEST_TO_EMAIL is not set");

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
    const durations = await getVideoDurations(fresh.map((v) => v.id).filter(Boolean) as string[]);
    const watchable = fresh.filter((v) => !v.id || !durations[v.id] || !isShort(durations[v.id]));
    console.log(`  ${videos.length} fetched, ${fresh.length} in last 24h, ${fresh.length - watchable.length} shorts filtered`);

    for (const video of watchable) {
      const stored = await processVideo(video, "channel", ch.label);
      if (stored) newVideos.push(stored);
    }
  }

  for (const topic of config.topics) {
    console.log(`\nTopic: "${topic}"`);
    const videos = await searchVideos(topic, config.settings.videosPerTopic);
    const fresh = videos.filter((v) => v.publishedAt >= CUTOFF);
    console.log(`  ${videos.length} fetched, ${fresh.length} published in last 24h`);

    for (const video of fresh) {
      const stored = await processVideo(video, "topic");
      if (stored) newVideos.push(stored);
    }
  }

  console.log(`\nDone. ${newVideos.length} new video(s) processed.`);

  if (newVideos.length === 0) {
    console.log("Nothing new — skipping email.");
    return;
  }

  console.log(`Sending digest to ${toEmail}...`);
  await sendDigestEmail(newVideos, toEmail, undefined, hideSkipped);
  console.log("Email sent.");
}

main().catch((err) => {
  console.error("Fatal:", err.message ?? err);
  process.exit(1);
});
