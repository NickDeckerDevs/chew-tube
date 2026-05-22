/*
5/22/2026 - nick decker | db utility + email revisions
ADDED
- `decodeHtml()` — shared HTML entity decoder, previously duplicated in youtube.ts and mailer.ts

5/22/2026 - nick decker | refactor
ADDED
- `HAIKU_MODEL` — single source of truth for the Claude model ID used across summarizer and backfill
- `getAnthropicClient()` — shared Anthropic client factory, previously duplicated in summarizer.ts and backfill.ts
- `runScript(fn)` — shared async script runner with error handling, previously copy-pasted in every script entry point
*/

import Anthropic from "@anthropic-ai/sdk";

export const HAIKU_MODEL = "claude-haiku-4-5-20251001";

export function getAnthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set in .env");
  return new Anthropic({ apiKey });
}

export function runScript(fn: () => void | Promise<void>): void {
  Promise.resolve(fn()).catch((err: Error) => {
    console.error("Fatal:", err.message ?? err);
    process.exit(1);
  });
}

export function decodeHtml(str: string): string {
  return (str ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&apos;/g, "'");
}
