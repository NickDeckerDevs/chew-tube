/*
5/22/2026 - nick decker | phase 2 bug fix
FIXED
- Validate `key_takeaways` is an array at the API boundary in `callSummaryTool` — Claude's tool_use response is cast with `as`, so a malformed response could silently produce `undefined`, causing `keyTakeaways.map is not a function` in the mailer
*/

import Anthropic from "@anthropic-ai/sdk";
import type { Summary } from "./db.js";
import { splitTranscript } from "./transcript.js";

const MODEL = "claude-haiku-4-5-20251001";

const SUMMARY_TOOL: Anthropic.Tool = {
  name: "submit_summary",
  description: "Submit the structured summary of a YouTube video transcript.",
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
      worth_watching: {
        type: "boolean",
        description:
          "True if a developer/tech professional would find genuine value in watching the full video.",
      },
      worth_watching_reason: {
        type: "string",
        description: "One sentence explaining the worth_watching verdict.",
      },
    },
    required: [
      "one_liner",
      "key_takeaways",
      "worth_watching",
      "worth_watching_reason",
    ],
  },
};

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set in .env");
  return new Anthropic({ apiKey });
}

async function callSummaryTool(
  client: Anthropic,
  systemPrompt: string,
  userMessage: string
): Promise<Summary> {
  const response = await client.messages.create({
    model: MODEL,
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
    key_takeaways: string[];
    worth_watching: boolean;
    worth_watching_reason: string;
  };

  return {
    oneLiner: input.one_liner,
    keyTakeaways: Array.isArray(input.key_takeaways)
      ? (input.key_takeaways as unknown[]).filter((t): t is string => typeof t === "string")
      : [],
    worthWatching: input.worth_watching,
    worthWatchingReason: input.worth_watching_reason,
  };
}

async function summarizeChunks(
  client: Anthropic,
  title: string,
  chunks: string[]
): Promise<Summary> {
  const chunkSummaries: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const res = await client.messages.create({
      model: MODEL,
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
    `You are summarizing a YouTube video based on section-by-section summaries. Produce the final structured summary.`,
    `Video title: "${title}"\n\nSection summaries:\n${chunkSummaries.join("\n\n")}`
  );
}

export async function summarize(
  title: string,
  transcript: string,
  chunked: boolean
): Promise<Summary> {
  const client = getClient();

  if (chunked) {
    const chunks = splitTranscript(transcript);
    return summarizeChunks(client, title, chunks);
  }

  return callSummaryTool(
    client,
    `You are summarizing YouTube video transcripts. Produce concise, useful summaries for a busy developer.`,
    `Video title: "${title}"\n\nTranscript:\n${transcript}`
  );
}
