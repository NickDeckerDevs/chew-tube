import { YoutubeTranscript } from "youtube-transcript";

const TOKEN_THRESHOLD = 120_000;
const CHUNK_TOKEN_SIZE = 50_000;

// Rough token estimate: ~1.35 tokens per word for English
function estimateTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).length * 1.35);
}

function splitIntoChunks(text: string, maxTokens: number): string[] {
  const words = text.split(/\s+/);
  const wordsPerChunk = Math.floor(maxTokens / 1.35);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    chunks.push(words.slice(i, i + wordsPerChunk).join(" "));
  }
  return chunks;
}

export type TranscriptResult =
  | { ok: true; text: string; chunked: boolean; estimatedTokens: number }
  | { ok: false; reason: string };

export async function getTranscript(videoId: string): Promise<TranscriptResult> {
  let segments: { text: string }[];
  try {
    segments = await YoutubeTranscript.fetchTranscript(videoId);
  } catch {
    return { ok: false, reason: "no transcript available" };
  }

  if (!segments || segments.length === 0) {
    return { ok: false, reason: "transcript is empty" };
  }

  const fullText = segments.map((s) => s.text).join(" ");
  const estimatedTokens = estimateTokens(fullText);

  return {
    ok: true,
    text: fullText,
    chunked: estimatedTokens >= TOKEN_THRESHOLD,
    estimatedTokens,
  };
}

export function splitTranscript(text: string): string[] {
  return splitIntoChunks(text, CHUNK_TOKEN_SIZE);
}
