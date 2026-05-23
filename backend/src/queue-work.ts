/*
5/23/2026 - nick decker | queue worker
ADDED
- Drains the queue table one item at a time, calling Claude for each
- 15-second delay between Claude calls → ~4 calls/min → ~40k tokens/min (under 50k limit)
- Atomic dequeue (SELECT + UPDATE in transaction) prevents double-processing
- Resets any stuck 'processing' items to 'pending' on startup (crash recovery)
- Tracks verdicts per source label in memory
- Saves dated results JSON to data/results/ and updates manifest when queue drains
- Run via `npm run queue-work [test-name]`
*/

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { summarize } from "./summarizer.js";
import { getTopComments } from "./youtube.js";
import {
  isAlreadySummarized, saveVideo, dequeueNext, markQueueDone, markQueueFailed,
  getQueueStats, resetStuckItems,
} from "./db.js";
import { runScript } from "./utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, "../../data/results");
const MANIFEST_PATH = path.join(RESULTS_DIR, "manifest.json");
const DELAY_MS = 15_000;

type SourceResult = {
  label: string;
  sourceType: string;
  processed: number;
  verdicts: { watch: number; conditional: number; skip: number };
  skipRate: number;
};

type ManifestEntry = { file: string; name: string; runAt: string };

function loadManifest(): ManifestEntry[] {
  try { return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8")); }
  catch { return []; }
}

async function main(): Promise<void> {
  const testName = process.argv[2] ?? "skip-rate-baseline";
  const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../config.json"), "utf-8")
  ) as { settings: { persona?: string } };
  const persona = config.settings.persona ?? "a general viewer";

  const stuck = resetStuckItems();
  if (stuck > 0) console.log(`Reset ${stuck} stuck item(s) to pending.`);

  const stats = getQueueStats();
  const pending = stats.pending ?? 0;
  if (pending === 0) { console.log("Queue is empty. Run queue-fill first."); return; }

  console.log(`Queue worker — test: "${testName}"`);
  console.log(`Persona: ${persona}`);
  console.log(`Pending: ${pending}  Delay: ${DELAY_MS / 1000}s between calls\n`);

  const sources = new Map<string, SourceResult>();
  let processed = 0;
  const startedAt = new Date().toISOString();

  while (true) {
    const item = dequeueNext();
    if (!item) break;

    const src = sources.get(item.sourceLabel) ?? {
      label: item.sourceLabel,
      sourceType: item.sourceType,
      processed: 0,
      verdicts: { watch: 0, conditional: 0, skip: 0 },
      skipRate: 0,
    };

    process.stdout.write(`[${item.sourceLabel}] ${item.title.slice(0, 55)}...`);

    try {
      const summary = await summarize(
        item.title, item.transcript, item.chunked, persona,
        item.sourceType as "channel" | "topic", item.channelLabel
      );
      const comments = await getTopComments(item.id, 2);
      summary.topComments = comments.length > 0 ? comments : null;

      if (!isAlreadySummarized(item.id)) {
        saveVideo(
          {
            id: item.id, title: item.title, channel: item.channel,
            publishedAt: item.publishedAt, description: item.description,
            thumbnailUrl: item.thumbnailUrl,
          },
          summary
        );
      }

      markQueueDone(item.id);

      const v = (summary.verdict ?? "skip") as "watch" | "conditional" | "skip";
      if (v in src.verdicts) src.verdicts[v]++;
      src.processed++;
      processed++;
      sources.set(item.sourceLabel, src);
      console.log(` ${v}`);
    } catch (err) {
      const msg = (err as Error).message;
      markQueueFailed(item.id, msg);
      console.log(` FAILED: ${msg.slice(0, 80)}`);
    }

    const remaining = getQueueStats().pending ?? 0;
    if (remaining > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  // Compute skip rates
  const sourceList = Array.from(sources.values()).map((s) => ({
    ...s,
    skipRate: s.processed > 0 ? s.verdicts.skip / s.processed : 0,
  }));

  const totals = sourceList.reduce(
    (acc, s) => ({
      processed: acc.processed + s.processed,
      watch: acc.watch + s.verdicts.watch,
      conditional: acc.conditional + s.verdicts.conditional,
      skip: acc.skip + s.verdicts.skip,
      skipRate: 0,
    }),
    { processed: 0, watch: 0, conditional: 0, skip: 0, skipRate: 0 }
  );
  totals.skipRate = totals.processed > 0 ? totals.skip / totals.processed : 0;

  const finalStats = getQueueStats();
  const result = { testName, runAt: startedAt, completedAt: new Date().toISOString(), persona, sources: sourceList, totals, queueStats: finalStats };

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const filename = `${date}-${testName}.json`;
  fs.writeFileSync(path.join(RESULTS_DIR, filename), JSON.stringify(result, null, 2));

  const manifest = loadManifest();
  const idx = manifest.findIndex((e) => e.file === filename);
  const entry: ManifestEntry = { file: filename, name: testName, runAt: startedAt };
  if (idx >= 0) manifest[idx] = entry; else manifest.unshift(entry);
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

  console.log(`\n── Results ─────────────────────────────`);
  console.log(`  Processed: ${processed}`);
  console.log(`  Watch:     ${totals.watch}  (${pct(totals.watch, totals.processed)}%)`);
  console.log(`  Cond:      ${totals.conditional}  (${pct(totals.conditional, totals.processed)}%)`);
  console.log(`  Skip:      ${totals.skip}  (${pct(totals.skip, totals.processed)}%)`);
  console.log(`  Failed:    ${finalStats.failed ?? 0}`);
  console.log(`\nSaved → data/results/${filename}`);
}

function pct(n: number, total: number): string {
  return total > 0 ? Math.round((n / total) * 100).toString() : "0";
}

runScript(main);
