/*
5/23/2026 - nick decker | playlist fetch timing benchmark
ADDED
- Runs 100 trials across 3 pagination strategies for playlist fetches
- Strategies: 2×20, 3×20, 1×50 items per request
- Logs timing averages per strategy to compare latency profiles
- Run via `npm run benchmark-playlist`
*/

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getYouTube } from "./youtube.js";
import { runScript } from "./utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TRIALS = 100;

const STRATEGIES = [
  { label: "2 calls × 20 (40 items)", pageSize: 20, pages: 2 },
  { label: "3 calls × 20 (60 items)", pageSize: 20, pages: 3 },
  { label: "1 call  × 50 (50 items)", pageSize: 50, pages: 1 },
];

async function fetchPaginated(playlistId: string, pageSize: number, pages: number): Promise<void> {
  const yt = getYouTube();
  let pageToken: string | undefined;
  for (let p = 0; p < pages; p++) {
    const res = await yt.playlistItems.list({
      part: ["snippet"],
      playlistId,
      maxResults: pageSize,
      ...(pageToken ? { pageToken } : {}),
    });
    pageToken = res.data.nextPageToken ?? undefined;
    if (!pageToken && p < pages - 1) break;
  }
}

function pct(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return {
    min: sorted[0],
    mean: Math.round(mean),
    median: pct(sorted, 50),
    p95: pct(sorted, 95),
    max: sorted[sorted.length - 1],
  };
}

async function main(): Promise<void> {
  const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../config.json"), "utf-8")
  ) as { channels: { uploadsPlaylistId?: string; label: string }[] };

  const channel = config.channels.find((ch) => ch.uploadsPlaylistId);
  if (!channel?.uploadsPlaylistId) throw new Error("No channel with uploadsPlaylistId in config");

  console.log(`Target: ${channel.label} (${channel.uploadsPlaylistId})`);
  console.log(`${TRIALS} trials × ${STRATEGIES.length} strategies\n`);

  const timings: Record<string, number[]> = {};
  for (const s of STRATEGIES) timings[s.label] = [];

  const scriptStart = performance.now();

  for (const strategy of STRATEGIES) {
    process.stdout.write(`${strategy.label}: `);
    for (let i = 0; i < TRIALS; i++) {
      const t0 = performance.now();
      await fetchPaginated(channel.uploadsPlaylistId!, strategy.pageSize, strategy.pages);
      timings[strategy.label].push(Math.round(performance.now() - t0));
      if ((i + 1) % 25 === 0) process.stdout.write(`${i + 1} `);
    }
    console.log("done");
  }

  const totalMs = Math.round(performance.now() - scriptStart);
  console.log(`\nTotal runtime: ${(totalMs / 1000).toFixed(1)}s\n`);

  const pad = (s: string | number, w: number) => String(s).padEnd(w);
  console.log(`${pad("strategy", 30)} ${pad("min", 7)} ${pad("mean", 7)} ${pad("median", 8)} ${pad("p95", 7)} max`);
  console.log("─".repeat(68));
  for (const strategy of STRATEGIES) {
    const s = stats(timings[strategy.label]);
    console.log(`${pad(strategy.label, 30)} ${pad(s.min, 7)} ${pad(s.mean, 7)} ${pad(s.median, 8)} ${pad(s.p95, 7)} ${s.max}`);
  }

  const outDir = path.join(__dirname, "../../data");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "benchmark-playlist.json");
  fs.writeFileSync(outPath, JSON.stringify({ target: channel.label, trials: TRIALS, strategies: STRATEGIES, timings }, null, 2));
  console.log(`\nRaw data → data/benchmark-playlist.json`);
}

runScript(main);
