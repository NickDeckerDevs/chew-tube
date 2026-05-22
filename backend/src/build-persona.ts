/*
5/22/2026 - nick decker | persona profile builder
ADDED
- Fetches top 5 videos per configured channel (title + description only, no transcription)
- Sends all channel content to Claude in one call to produce:
    - Per-channel summary: what it covers and what it reveals about viewer interest
    - Category groupings: channels that share a theme, grouped by Claude
    - Per-category synthesis: richer interest signal from multiple channels in the same space
- Saves result to backend/persona-profile.json
- Run via `npm run build-persona` whenever channels change
- Output is consumed by summarizer.ts to enrich the verdict prompt
*/

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getChannelVideos, getUploadsPlaylistId, getPlaylistVideos } from "./youtube.js";
import { getAnthropicClient, HAIKU_MODEL } from "./utils.js";
import { runScript } from "./utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type ChannelEntry = { id?: string; label: string };
type DigestConfig = {
  channels: ChannelEntry[];
  settings: { persona?: string };
};

export type ChannelProfile = {
  label: string;
  summary: string;
};

export type CategoryProfile = {
  name: string;
  channels: string[];
  summary: string;
};

export type PersonaProfile = {
  generatedAt: string;
  statedPersona: string;
  channels: Record<string, ChannelProfile>;  // keyed by channel label
  categories: CategoryProfile[];
};

const PROFILE_PATH = path.join(__dirname, "../persona-profile.json");

export function loadPersonaProfile(): PersonaProfile | null {
  try {
    return JSON.parse(fs.readFileSync(PROFILE_PATH, "utf-8")) as PersonaProfile;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../config.json"), "utf-8")
  ) as DigestConfig;

  const statedPersona = config.settings.persona ?? "a general viewer";
  const channels = config.channels.filter((ch) => ch.id);

  console.log(`Building persona profile from ${channels.length} channels...`);

  // Fetch top 5 videos per channel (title + description only — no transcription needed)
  const channelData: { label: string; videos: { title: string; description: string }[] }[] = [];

  for (const ch of channels) {
    process.stdout.write(`  ${ch.label}...`);
    try {
      // Use uploads playlist (1 quota unit) instead of search.list (100 units)
      const uploadsId = await getUploadsPlaylistId(ch.id!);
      const videos = uploadsId
        ? await getPlaylistVideos(uploadsId, 5)
        : await getChannelVideos(ch.id!, 5);
      channelData.push({
        label: ch.label,
        videos: videos.map((v) => ({
          title: v.title,
          description: v.description?.slice(0, 200) ?? "",
        })),
      });
      console.log(` ${videos.length} videos`);
    } catch (err) {
      console.log(` failed (${(err as Error).message})`);
    }
  }

  if (channelData.length === 0) {
    throw new Error("No channel data fetched — check YOUTUBE_API_KEY");
  }

  // Build the prompt for Claude
  const channelBlocks = channelData.map((ch) => {
    const videoList = ch.videos
      .map((v, i) => `  ${i + 1}. "${v.title}"${v.description ? `\n     ${v.description}` : ""}`)
      .join("\n");
    return `### ${ch.label}\n${videoList}`;
  }).join("\n\n");

  const prompt = `You are building a viewer interest profile from their YouTube channel subscriptions.

The viewer describes themselves as: "${statedPersona}"

Below are the channels they follow, with each channel's 5 most recent videos:

${channelBlocks}

Produce a JSON object with this exact structure:

{
  "channels": {
    "<channel label>": {
      "label": "<channel label>",
      "summary": "<2-3 sentences: what this channel covers and what interest it reveals about the viewer>"
    }
  },
  "categories": [
    {
      "name": "<thematic category name>",
      "channels": ["<label>", "<label>"],
      "summary": "<3-5 sentences synthesizing viewer interest across these channels in this category. If only one channel, still write the category summary to capture what aspect of this topic the viewer cares about based on the content they watch.>"
    }
  ]
}

Group channels into meaningful thematic categories based on shared subject matter. A channel should belong to exactly one category. Categories should be broad enough to group related channels but specific enough to be useful (e.g. "AI & Developer Tools", "Cooking & Food", "Gaming", "Political Commentary"). Write the category summaries to be genuinely useful for deciding whether a new video fits this viewer's interests — not just a list of channel names.

Respond with the JSON object only, no markdown fences.`;

  console.log("\nAsking Claude to build channel + category profiles...");
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  let parsed: { channels: Record<string, ChannelProfile>; categories: CategoryProfile[] };
  try {
    const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    parsed = JSON.parse(stripped);
  } catch {
    throw new Error(`Claude returned invalid JSON:\n${text}`);
  }

  const profile: PersonaProfile = {
    generatedAt: new Date().toISOString(),
    statedPersona,
    channels: parsed.channels,
    categories: parsed.categories,
  };

  fs.writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2));
  console.log(`\nProfile saved to persona-profile.json`);
  console.log(`\nCategories identified:`);
  for (const cat of profile.categories) {
    console.log(`  ${cat.name} — ${cat.channels.join(", ")}`);
  }
}

// Only run when executed directly — not when imported for loadPersonaProfile/types
if (process.argv[1]?.endsWith("build-persona.ts") || process.argv[1]?.endsWith("build-persona.js")) {
  runScript(main);
}
