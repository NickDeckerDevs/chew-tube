/*
5/22/2026 - nick decker | verdict algorithm v2
ADDED
- Topic test script: fetches 5 videos per configured topic keyword (15 total for 3 topics)
- New videos: full v2 pipeline — transcript, summarize with persona + sourceType="topic", comments, save to DB
- Already-in-DB videos without v2 verdict: re-scored in place
- Already-in-DB videos with v2 verdict: used as-is
- Sends digest email with all 15 results for side-by-side topic verdict review
- Run via `npm run test-topics`
*/

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { searchVideos, getTopComments } from "./youtube.js";
import { getTranscript } from "./transcript.js";
import { summarize } from "./summarizer.js";
import { isAlreadySummarized, saveVideo, getVideosByIds, updateVideoColumn, getDb } from "./db.js";
import type { StoredVideo } from "./db.js";
import { sendDigestEmail } from "./mailer.js";
import { runScript } from "./utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type DigestConfig = {
  topics: string[];
  settings: { persona?: string };
};

const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../config.json"), "utf-8")
) as DigestConfig;

const persona = config.settings.persona ?? "a general viewer";
const VIDEOS_PER_TOPIC = 5;

async function processVideo(videoId: string, title: string): Promise<StoredVideo | null> {
  const result = await getTranscript(videoId);
  if (!result.ok) {
    console.log(`  ✗ no transcript (${result.reason})`);
    return null;
  }

  const summary = await summarize(title, result.text, result.chunked, persona, "topic");
  const comments = await getTopComments(videoId, 2);
  summary.topComments = comments.length > 0 ? comments : null;

  return summary as unknown as StoredVideo; // returned to caller for save + hydration
}

async function main(): Promise<void> {
  const toEmail = process.env.DIGEST_TO_EMAIL;
  if (!toEmail) throw new Error("DIGEST_TO_EMAIL is not set");

  console.log(`Topic test — ${VIDEOS_PER_TOPIC} videos × ${config.topics.length} topics`);
  console.log(`Persona: ${persona}\n`);

  const allIds: string[] = [];
  const toProcess: { id: string; title: string; channel: string; publishedAt: string; description: string; thumbnailUrl?: string }[] = [];

  // Fetch from each topic
  for (const topic of config.topics) {
    console.log(`Topic: "${topic}"`);
    const videos = await searchVideos(topic, VIDEOS_PER_TOPIC);
    console.log(`  Fetched ${videos.length} results`);

    for (const v of videos) {
      if (!v.id) continue;
      allIds.push(v.id);

      if (isAlreadySummarized(v.id)) {
        // Check if it has a v2 verdict already
        const existing = getVideosByIds([v.id])[0];
        if (existing?.verdict) {
          console.log(`  [cached v2] ${v.title.slice(0, 55)}`);
        } else {
          // In DB but no v2 verdict — re-score it
          console.log(`  [rescore]   ${v.title.slice(0, 55)}`);
          const result = await getTranscript(v.id);
          if (result.ok) {
            const summary = await summarize(v.title, result.text, result.chunked, persona, "topic");
            const comments = await getTopComments(v.id, 2);
            if (summary.verdict) updateVideoColumn(v.id, "verdict", summary.verdict);
            if (summary.verdictDetail) updateVideoColumn(v.id, "verdict_detail", summary.verdictDetail);
            if (summary.clickbaitReason !== null) updateVideoColumn(v.id, "clickbait_reason", summary.clickbaitReason);
            updateVideoColumn(v.id, "top_comments", comments.length > 0 ? JSON.stringify(comments) : null);
            getDb().prepare("UPDATE videos SET clickbait = ? WHERE id = ?").run(
              summary.clickbait === null ? null : (summary.clickbait ? 1 : 0), v.id
            );
            console.log(`    → ${summary.verdict ?? "?"}`);
          }
        }
      } else {
        toProcess.push(v);
      }
    }
  }

  // Process new videos
  if (toProcess.length > 0) {
    console.log(`\nProcessing ${toProcess.length} new video(s)...`);
    for (const v of toProcess) {
      process.stdout.write(`  ${v.title.slice(0, 55)}...`);
      const result = await getTranscript(v.id);
      if (!result.ok) {
        console.log(` ✗ no transcript`);
        continue;
      }
      const summary = await summarize(v.title, result.text, result.chunked, persona, "topic");
      const comments = await getTopComments(v.id, 2);
      summary.topComments = comments.length > 0 ? comments : null;
      saveVideo(v, summary);
      console.log(` ${summary.verdict ?? "?"}`);
    }
  }

  const results = getVideosByIds(allIds).filter((v): v is StoredVideo => !!v);
  console.log(`\n${results.length} videos ready. Sending email to ${toEmail}...`);
  await sendDigestEmail(results, toEmail, "Topic Test — v2 Verdicts");
  console.log("Done.");
}

runScript(main);
