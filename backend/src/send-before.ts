/*
5/22/2026 - nick decker | verdict algorithm v2
ADDED
- Sends the "before" comparison email — 30 control set videos scored with the old algorithm
- Reads IDs from control-set.json, fetches from DB, sends via sendDigestEmail
- Run before deploying v2 algorithm; pair with `npm run send-after` post-rescore
*/

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getVideosByIds } from "./db.js";
import { sendDigestEmail } from "./mailer.js";
import { runScript } from "./utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const toEmail = process.env.DIGEST_TO_EMAIL;
  if (!toEmail) throw new Error("DIGEST_TO_EMAIL is not set");

  const controlSet = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../control-set.json"), "utf-8")
  ) as { ids: string[] };

  const videos = getVideosByIds(controlSet.ids);
  if (videos.length === 0) {
    console.log("No control set videos found in DB.");
    process.exit(1);
  }

  console.log(`Sending BEFORE email (${videos.length} control videos, old algorithm) to ${toEmail}...`);
  await sendDigestEmail(videos, toEmail, "BEFORE — Old Algorithm");
  console.log("Done.");
}

runScript(main);
