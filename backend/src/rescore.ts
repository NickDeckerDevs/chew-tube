/*
5/22/2026 - nick decker | verdict algorithm v2
ADDED
- Re-scores control set videos with the v2 algorithm (persona + 3-tier verdict + clickbait)
- Re-fetches transcripts from YouTube (not stored in DB), runs new summarize() with config persona
- Fetches top 2 comments per video
- Updates verdict, verdict_detail, clickbait, clickbait_reason, top_comments in DB (does NOT change
  old fields — worth_watching, worth_watching_reason stay intact for before/after comparison)
- Sends "after" comparison email when done
- Source type defaults to "topic" for all control set videos since original source was not tracked
*/

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getVideosByIds, updateVideoColumn } from "./db.js";
import { getTranscript } from "./transcript.js";
import { summarize } from "./summarizer.js";
import { getTopComments } from "./youtube.js";
import { sendDigestEmail } from "./mailer.js";
import { runScript } from "./utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type DigestConfig = {
  settings: { persona?: string };
};

const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../config.json"), "utf-8")
) as DigestConfig;

const persona = config.settings.persona ?? "a general viewer";

async function main(): Promise<void> {
  const toEmail = process.env.DIGEST_TO_EMAIL;
  if (!toEmail) throw new Error("DIGEST_TO_EMAIL is not set");

  const controlSet = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../control-set.json"), "utf-8")
  ) as { ids: string[] };

  const videos = getVideosByIds(controlSet.ids);
  console.log(`Rescoring ${videos.length} control set videos with v2 algorithm`);
  console.log(`Persona: ${persona}\n`);

  for (const video of videos) {
    process.stdout.write(`${video.title.slice(0, 60)}...`);

    const result = await getTranscript(video.id);
    if (!result.ok) {
      console.log(` no transcript (${result.reason}) — skipping`);
      continue;
    }

    // source_type not tracked on old rows — use "topic" (conservative, no channel boost)
    const summary = await summarize(video.title, result.text, result.chunked, persona, "topic");
    const comments = await getTopComments(video.id, 2);

    // Patch only v2 fields — leave worth_watching and worth_watching_reason untouched for comparison
    if (summary.verdict) updateVideoColumn(video.id, "verdict", summary.verdict);
    if (summary.verdictDetail) updateVideoColumn(video.id, "verdict_detail", summary.verdictDetail);
    if (summary.clickbaitReason !== null) updateVideoColumn(video.id, "clickbait_reason", summary.clickbaitReason);
    updateVideoColumn(video.id, "top_comments", comments.length > 0 ? JSON.stringify(comments) : null);

    // clickbait is integer column — use worth_watching_reason field as proxy for now
    // (updateVideoColumn only accepts string | null; clickbait boolean needs direct SQL)
    const db = (await import("./db.js")).getDb();
    db.prepare("UPDATE videos SET clickbait = ? WHERE id = ?").run(
      summary.clickbait === null ? null : (summary.clickbait ? 1 : 0),
      video.id
    );

    console.log(` ${summary.verdict ?? "?"}`);
  }

  console.log("\nRescoring complete. Fetching updated rows...");
  const updated = getVideosByIds(controlSet.ids);

  console.log(`Sending AFTER email (${updated.length} videos, v2 algorithm) to ${toEmail}...`);
  await sendDigestEmail(updated, toEmail, "AFTER — v2 Algorithm");
  console.log("Done.");
}

runScript(main);
