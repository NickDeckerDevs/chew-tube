/*
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
    ],
  },
};

function buildSystemPrompt(persona: string, sourceType: SourceType): string {
  const sourceContext = sourceType === "channel"
    ? "This video came from a channel the viewer explicitly subscribed to, so they have existing interest in this creator's content. Raise the bar for a skip verdict — if the content is decent and on-topic for the persona, lean toward watch or conditional."
    : "This video came from a keyword/topic search, so relevance to the persona is less guaranteed. Apply normal verdict criteria.";

  return `You are a sharp video curator summarizing YouTube content for a specific viewer.

Viewer persona: ${persona}

${sourceContext}

Your job is to produce a concise structured summary and an honest verdict. The verdict should be genuinely useful — not reflexively positive. If a video is filler-heavy, clickbait, or irrelevant to this viewer, say so clearly and specifically. If a channel repeatedly produces content that doesn't serve this viewer, flag it in the verdict_detail so they can decide whether to keep following.`;
}

async function callSummaryTool(
  client: Anthropic,
  systemPrompt: string,
  userMessage: string
): Promise<Summary> {
  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    tools: [SUMMARY_TOOL],
    tool_choice: { type: "any" },
    messages: [{ role: "user", content: userMessage }],
  });

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
  };

  const verdict = ["watch", "conditional", "skip"].includes(input.verdict)
    ? input.verdict
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
    topComments: null, // populated separately by digest.ts after fetch
  };
}

async function summarizeChunks(
  client: Anthropic,
  title: string,
  chunks: string[],
  systemPrompt: string
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
  sourceType: SourceType = "topic"
): Promise<Summary> {
  const client = getAnthropicClient();
  const systemPrompt = buildSystemPrompt(persona, sourceType);

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
