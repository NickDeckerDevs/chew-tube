/*
5/22/2026 - nick decker | email revisions
ADDED
- Test script: pulls 5 random videos from the DB and sends a digest email
- Used to verify email template changes without waiting for new videos to be published
- Run via `npm run test-email`

5/22/2026 - nick decker | refactor
CHANGED
- Error handling via `runScript()` from utils.ts
*/

import "dotenv/config";
import { getRandomVideos } from "./db.js";
import { sendDigestEmail } from "./mailer.js";
import { runScript } from "./utils.js";

async function main(): Promise<void> {
  const toEmail = process.env.DIGEST_TO_EMAIL;
  if (!toEmail) throw new Error("DIGEST_TO_EMAIL is not set");

  const videos = getRandomVideos(5);
  if (videos.length === 0) {
    console.log("No videos in DB yet. Run the digest or CLI first.");
    process.exit(0);
  }

  console.log(`Sending test digest (${videos.length} random videos) to ${toEmail}...`);
  await sendDigestEmail(videos, toEmail);
  console.log("Done.");
}

runScript(main);
