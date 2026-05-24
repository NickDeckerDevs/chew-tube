/*
5/23/2026 - nick decker | explicit persona match signals
ADDED
- `persona_match` field in tool schema — "strong" | "partial" | "none", evaluated independently of verdict
- `channel_categories_matched` field in tool schema — integer 0–3, counts channel-derived persona category alignments
- Both mapped in `callSummaryTool` and returned in `Summary`

5/23/2026 - nick decker | category preference signal
CHANGED
- `buildSystemPrompt()` accepts optional `categoryScore` (1–5) and injects interest-level guidance
- `summarize()` accepts optional `categoryScore` and passes it through to `buildSystemPrompt()`
- Score 1–2: raises skip bar explicitly; score 4–5: lowers it; score 3: neutral

5/22/2026 - nick decker | verdict algorithm v2
CHANGED
- `summarize()` now accepts `persona` and `sourceType` ("channel" | "topic") parameters
- System prompt injects persona and source context so Claude calibrates verdict to the user
- Tool schema updated: `worth_watching` (binary) kept for backwards compat; added `verdict` (3-tier),
  `verdict_detail` (nuanced reason / "watch if X, skip if Y"), `clickbait` (boolean), `clickbait_reason`
- Scoring guidance in prompt: persona match + channel source = boosted; title-transcript mismatch
  + filler-heavy content = lowered; piling skips on a channel flagged in verdict_detail
- `callSummaryTool` returns full Summary including all v2 fields

5/22/2026 - nick decker | phase 2 bug fix
FIXED
- Validate `key_takeaways` is an array at the API boundary in `callSummaryTool` — Claude's tool_use response is cast with `as`, so a malformed response could silently produce `undefined`, causing `keyTakeaways.map is not a function` in the mailer

5/22/2026 - nick decker | email revisions
ADDED
- `short_summary` field to the Claude tool schema — 2-3 sentence digest preview generated alongside the existing summary
- `shortSummary` returned in the `Summary` object and passed through to DB storage

5/22/2026 - nick decker | refactor
CHANGED
- `MODEL` constant replaced by `HAIKU_MODEL` imported from utils.ts
- `getClient()` replaced by `getAnthropicClient()` imported from utils.ts
*/

import type { Summary } from "./db.js";
import { splitTranscript } from "./transcript.js";
import { HAIKU_MODEL, getAnthropicClient } from "./utils.js";
import { loadPersonaProfile } from "./build-persona.js";
import type { PersonaProfile } from "./build-persona.js";
import type Anthropic from "@anthropic-ai/sdk";

export type SourceType = "channel" | "topic";

const SUMMARY_TOOL: Anthropic.Tool = {
  name: "submit_summary",
  description: "Submit the structured summary and verdict for a YouTube video.",
  input_schema: {
    type: "object" as const,
    properties: {
      one_liner: {
        type: "string",
        description: "A single sentence describing what the video is about.",
      },
      key_takeaways: {
        type: "array",
        items: { type: "string" },
        description: "3 to 5 bullet points capturing the most important points.",
      },
      short_summary: {
        type: "string",
        description: "A 2-3 sentence plain prose summary suitable for a digest email preview. No markdown, no headers, no bullet points.",
      },
      worth_watching: {
        type: "boolean",
        description: "True if the viewer would find genuine value watching the full video. Derived from verdict: watch/conditional=true, skip=false.",
      },
      worth_watching_reason: {
        type: "string",
        description: "One sentence explaining the verdict. Same as verdict_detail.",
      },
      verdict: {
        type: "string",
        enum: ["watch", "conditional", "skip"],
        description: `Three-tier verdict calibrated to the viewer's persona and how the video was found.
- "watch": content clearly matches persona interests AND delivers on its title with minimal filler
- "conditional": has value for some viewers but not all — use verdict_detail to specify "Watch if you care about X, skip if Y"
- "skip": title doesn't match content (clickbait), excessive filler/padding, or not relevant to persona at all

Boost toward watch: content directly matches persona | video came from a subscribed channel (channel source)
Lower toward skip: title promise vs transcript mismatch | more than ~40% filler/padding/sponsor reads | off-topic for persona`,
      },
      verdict_detail: {
        type: "string",
        description: `Nuanced one-to-two sentence verdict reason.
For "watch": why it's worth the time.
For "conditional": "Watch if you care about [X]. Skip if [Y]."
For "skip": be specific — is it clickbait, filler-heavy, off-topic, or a channel worth reconsidering?
If skipping due to filler or repeated off-topic content, note it so the viewer can decide whether to keep following this creator.`,
      },
      clickbait: {
        type: "boolean",
        description: "True if the title makes a promise the transcript does not meaningfully deliver on. Sensationalized titles that accurately represent content are NOT clickbait.",
      },
      clickbait_reason: {
        type: "string",
        description: "If clickbait is true: one sentence explaining the mismatch between title and content. Empty string if not clickbait.",
      },
      persona_match: {
        type: "string",
        enum: ["strong", "partial", "none"],
        description: `How well this video's content aligns with the viewer's STATED persona. Evaluate this independently of the verdict — a clickbait video about cooking is still "strong" for someone who loves cooking; a genuinely great video about an unrelated topic is still "none".
- "strong": content directly and clearly serves the viewer's stated interests
- "partial": tangentially relevant — adjacent to their interests but not a direct match
- "none": no meaningful connection to the stated persona`,
      },
      channel_categories_matched: {
        type: "number",
        description: `How many of the viewer's revealed interest categories (from the channel-derived persona block) this video meaningfully aligns with. Count the thematic groups — cooking channels, gaming channels, etc. — that this video's content speaks to. Return 0, 1, 2, or 3 (cap at 3 for three or more).`,
      },
    },
    required: [
      "one_liner",
      "key_takeaways",
      "short_summary",
      "worth_watching",
      "worth_watching_reason",
      "verdict",
      "verdict_detail",
      "clickbait",
      "clickbait_reason",
      "persona_match",
      "channel_categories_matched",
    ],
  },
};

function buildInterestContext(profile: PersonaProfile): string {
  const categoryBlock = profile.categories
    .map((cat) => `**${cat.name}** (${cat.channels.join(", ")})\n${cat.summary}`)
    .join("\n\n");

  return `The viewer's revealed interests, inferred from the channels they follow:

${categoryBlock}`;
}

const CATEGORY_SCORE_GUIDANCE: Record<number, string> = {
  1: "Category interest: 1/5 (very low) — the viewer has almost no interest in this content category. Apply a significantly higher bar; only recommend watch if the content is exceptional and directly relevant to their other stated interests. Default toward skip.",
  2: "Category interest: 2/5 (low) — the viewer has little interest in this content category. Lean toward skip unless the content is clearly and specifically relevant to their persona.",
  3: "Category interest: 3/5 (moderate) — apply normal verdict criteria.",
  4: "Category interest: 4/5 (high) — this is a category the viewer actively enjoys. Lean toward watch if content is decent and on-topic.",
  5: "Category interest: 5/5 (very high) — this is a core interest area. Only skip for clear clickbait or content that is completely off-topic for their persona.",
};

function buildSystemPrompt(persona: string, sourceType: SourceType, channelLabel?: string, categoryScore?: number): string {
  const profile = loadPersonaProfile();

  const sourceContext = sourceType === "channel"
    ? "This video came from a channel the viewer explicitly subscribed to, so they have existing interest in this creator's content. Raise the bar for a skip verdict — if the content is decent and on-topic for the persona, lean toward watch or conditional."
    : "This video came from a keyword/topic search, so relevance to the persona is less guaranteed. Apply normal verdict criteria.";

  const channelContext = channelLabel && profile?.channels[channelLabel]
    ? `\nAbout this specific channel (${channelLabel}): ${profile.channels[channelLabel].summary}`
    : "";

  const interestContext = profile
    ? `\n\n${buildInterestContext(profile)}`
    : "";

  const categoryContext = categoryScore !== undefined && CATEGORY_SCORE_GUIDANCE[categoryScore]
    ? `\n\n${CATEGORY_SCORE_GUIDANCE[categoryScore]}`
    : "";

  return `You are a sharp video curator summarizing YouTube content for a specific viewer.

Viewer's stated persona: ${persona}${interestContext}

${sourceContext}${channelContext}${categoryContext}

Your job is to produce a concise structured summary and an honest verdict. The verdict should be genuinely useful — not reflexively positive. If a video is filler-heavy, clickbait, or irrelevant to this viewer, say so clearly and specifically. If a channel repeatedly produces content that doesn't serve this viewer, flag it in the verdict_detail so they can decide whether to keep following.`;
}

async function callSummaryTool(
  client: Anthropic,
  systemPrompt: string,
  userMessage: string,
  attempt = 0
): Promise<Summary> {
  let response;
  try {
    response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    tools: [SUMMARY_TOOL],
    tool_choice: { type: "any" },
      messages: [{ role: "user", content: userMessage }],
    });
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    if (status === 429 && attempt < 3) {
      const wait = 60000 * (attempt + 1);
      process.stdout.write(` [rate limit, waiting ${wait / 1000}s]`);
      await new Promise((r) => setTimeout(r, wait));
      return callSummaryTool(client, systemPrompt, userMessage, attempt + 1);
    }
    throw err;
  }

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Claude did not call the summary tool");
  }

  const input = toolUse.input as {
    one_liner: string;
    key_takeaways: unknown[];
    short_summary: string;
    worth_watching: boolean;
    worth_watching_reason: string;
    verdict: "watch" | "conditional" | "skip";
    verdict_detail: string;
    clickbait: boolean;
    clickbait_reason: string;
    persona_match: "strong" | "partial" | "none";
    channel_categories_matched: number;
  };

  const verdict = ["watch", "conditional", "skip"].includes(input.verdict)
    ? input.verdict
    : null;

  const personaMatch = ["strong", "partial", "none"].includes(input.persona_match)
    ? input.persona_match
    : null;

  return {
    oneLiner: input.one_liner,
    keyTakeaways: Array.isArray(input.key_takeaways)
      ? (input.key_takeaways as unknown[]).filter((t): t is string => typeof t === "string")
      : [],
    shortSummary: typeof input.short_summary === "string" ? input.short_summary : "",
    worthWatching: input.worth_watching,
    worthWatchingReason: input.worth_watching_reason,
    verdict,
    verdictDetail: typeof input.verdict_detail === "string" ? input.verdict_detail : null,
    clickbait: typeof input.clickbait === "boolean" ? input.clickbait : null,
    clickbaitReason: typeof input.clickbait_reason === "string" ? input.clickbait_reason : null,
    personaMatch,
    channelCategoriesMatched: typeof input.channel_categories_matched === "number"
      ? Math.min(3, Math.max(0, Math.round(input.channel_categories_matched)))
      : null,
    topComments: null,
  };
}

async function summarizeChunks(
  client: Anthropic,
  title: string,
  chunks: string[],
  systemPrompt: string,
): Promise<Summary> {
  const chunkSummaries: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const res = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 512,
      messages: [
        {
          role: "user",
          content: `Summarize the key points from this section (${i + 1}/${chunks.length}) of the transcript for the video "${title}". Be concise — bullet points only.\n\n${chunks[i]}`,
        },
      ],
    });
    const text = res.content
      .filter((b) => b.type === "text")
      .map((b) => (b as Anthropic.TextBlock).text)
      .join(" ");
    chunkSummaries.push(text);
  }

  return callSummaryTool(
    client,
    systemPrompt,
    `Video title: "${title}"\n\nSection summaries:\n${chunkSummaries.join("\n\n")}`
  );
}

export async function summarize(
  title: string,
  transcript: string,
  chunked: boolean,
  persona = "a general viewer",
  sourceType: SourceType = "topic",
  channelLabel?: string,
  categoryScore?: number
): Promise<Summary> {
  const client = getAnthropicClient();
  const systemPrompt = buildSystemPrompt(persona, sourceType, channelLabel, categoryScore);

  if (chunked) {
    const chunks = splitTranscript(transcript);
    return summarizeChunks(client, title, chunks, systemPrompt);
  }

  return callSummaryTool(
    client,
    systemPrompt,
    `Video title: "${title}"\n\nTranscript:\n${transcript}`
  );
}
