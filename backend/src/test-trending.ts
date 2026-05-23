/*
5/22/2026 - nick decker | trending test
ADDED
- Fetches 30 top trending US videos, scores against full persona profile, sends digest email
- New videos: full v2 pipeline — transcript, summarize with persona + sourceType="topic", comments, save
- Already in DB with v2 verdict: used as-is
- Already in DB without v2 verdict: rescored in place
- Run via `npm run test-trending`
*/

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getTrending, getTopComments } from "./youtube.js";
import { getTranscript } from "./transcript.js";
import { summarize } from "./summarizer.js";
import { isAlreadySummarized, saveVideo, getVideosByIds, updateVideoColumn, getDb } from "./db.js";
import type { StoredVideo } from "./db.js";
import { sendDigestEmail } from "./mailer.js";
import { runScript } from "./utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type DigestConfig = { settings: { persona?: string } };
const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../config.json"), "utf-8")
) as DigestConfig;
const persona = config.settings.persona ?? "a general viewer";

async function main(): Promise<void> {
  const toEmail = process.env.DIGEST_TO_EMAIL;
  if (!toEmail) throw new Error("DIGEST_TO_EMAIL is not set");

  console.log(`Fetching top 30 trending US videos...`);
  const videos = await getTrending(30);
  console.log(`Fetched ${videos.length}. Processing against persona profile...\n`);

  const allIds: string[] = [];

  for (const video of videos) {
    if (!video.id) continue;
    allIds.push(video.id);

    if (isAlreadySummarized(video.id)) {
      const existing = getVideosByIds([video.id])[0];
      if (existing?.verdict) {
        console.log(`[cached] ${video.title.slice(0, 65)}`);
        continue;
      }
      // In DB but no v2 verdict — rescore
      process.stdout.write(`[rescore] ${video.title.slice(0, 60)}...`);
      const result = await getTranscript(video.id);
      if (!result.ok) { console.log(` no transcript`); continue; }
      const summary = await summarize(video.title, result.text, result.chunked, persona, "topic");
      const comments = await getTopComments(video.id, 2);
      if (summary.verdict) updateVideoColumn(video.id, "verdict", summary.verdict);
      if (summary.verdictDetail) updateVideoColumn(video.id, "verdict_detail", summary.verdictDetail);
      if (summary.clickbaitReason !== null) updateVideoColumn(video.id, "clickbait_reason", summary.clickbaitReason);
      updateVideoColumn(video.id, "top_comments", comments.length > 0 ? JSON.stringify(comments) : null);
      getDb().prepare("UPDATE videos SET clickbait = ? WHERE id = ?").run(
        summary.clickbait === null ? null : (summary.clickbait ? 1 : 0), video.id
      );
      console.log(` ${summary.verdict ?? "?"}`);
      continue;
    }

    process.stdout.write(`[new] ${video.title.slice(0, 65)}...`);
    const result = await getTranscript(video.id);
    if (!result.ok) { console.log(` no transcript`); continue; }
    const summary = await summarize(video.title, result.text, result.chunked, persona, "topic");
    const comments = await getTopComments(video.id, 2);
    summary.topComments = comments.length > 0 ? comments : null;
    saveVideo(video, summary);
    console.log(` ${summary.verdict ?? "?"}`);
  }

  const results = getVideosByIds(allIds.filter(Boolean));
  console.log(`\n${results.length} videos ready. Sending to ${toEmail}...`);
  await sendDigestEmail(results as StoredVideo[], toEmail, "Trending — v2 Verdicts");
  console.log("Done.");
}

runScript(main);
