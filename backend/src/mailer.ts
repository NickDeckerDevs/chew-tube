/*
5/22/2026 - nick decker | phase development
ADDED
- `sendDigestEmail(videos, to)` — builds and sends an HTML digest email via Resend SDK
- `buildHtml` and `buildVideoSection` helpers for per-video sections: title link, channel, one-liner, takeaways, worth-watching verdict
- `esc()` HTML entity escape helper for all user-generated content

5/22/2026 - nick decker | phase 2 bug fix
FIXED
- `esc()` now safely handles undefined/null at runtime — Claude API responses can return unexpected non-string values despite TypeScript types

5/22/2026 - nick decker | email revisions
ADDED
- Thumbnail image (320×180) rendered above title when `thumbnailUrl` is present
- Short summary (2-3 sentences) displayed below channel name, above one-liner
- TODO (Phase 3): replace video title link with a link to the Tube Chew frontend summary page once the frontend exists

5/22/2026 - nick decker | db utility + markdown rendering
CHANGED
- `decodeHtml` moved to shared `utils.ts`, imported from there
- `esc()` used only for title/channel (plain strings that should never have markdown)
- `md()` replaces `esc()` for all prose fields (shortSummary, oneLiner, worthWatchingReason, takeaway items) — converts markdown to email-safe HTML using `marked` with a custom renderer that inlines styles on headings
*/

import { marked } from "marked";
import { Resend } from "resend";
import type { StoredVideo } from "./db.js";
import { decodeHtml } from "./utils.js";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendDigestEmail(videos: StoredVideo[], to: string): Promise<void> {
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  await resend.emails.send({
    from: "Tube Chew <onboarding@resend.dev>",
    to,
    subject: `YouTube Digest — ${date}`,
    html: buildHtml(videos, date),
  });
}

function buildHtml(videos: StoredVideo[], date: string): string {
  const sections = videos.map(buildVideoSection).join("\n");
  const count = `${videos.length} new video${videos.length === 1 ? "" : "s"}`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>YouTube Digest</title>
</head>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333; background: #fff;">
  <h1 style="font-size: 22px; border-bottom: 2px solid #cc0000; padding-bottom: 12px; margin-bottom: 8px;">YouTube Digest</h1>
  <p style="color: #666; font-size: 14px; margin: 0 0 30px 0;">${date} &mdash; ${count}</p>
  ${sections}
  <p style="color: #999; font-size: 12px; margin-top: 40px; border-top: 1px solid #eee; padding-top: 16px;">
    Sent by Tube Chew
  </p>
</body>
</html>`;
}

function buildVideoSection(video: StoredVideo): string {
  const url = `https://youtube.com/watch?v=${video.id}`;
  const verdictColor = video.worthWatching ? "#2e7d32" : "#c62828";
  const verdictText = video.worthWatching ? "Worth watching" : "Skip it";
  const verdictIcon = video.worthWatching ? "✓" : "✗";
  const takeaways = video.keyTakeaways
    .map((t) => `<li style="margin-bottom: 6px;">${md(t)}</li>`)
    .join("\n    ");
  const thumbnail = video.thumbnailUrl
    ? `<img src="${video.thumbnailUrl}" width="320" alt="" style="width:100%;max-width:320px;height:auto;display:block;margin-bottom:12px;border-radius:4px;">`
    : "";
  const shortSummaryHtml = video.shortSummary
    ? `<div style="margin: 0 0 10px 0; line-height: 1.6;">${md(video.shortSummary)}</div>`
    : "";

  return `<div style="margin-bottom: 28px; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
  ${thumbnail}
  <h2 style="margin: 0 0 4px 0; font-size: 17px; line-height: 1.3;">
    <a href="${url}" style="color: #0066cc; text-decoration: none;">${esc(video.title)}</a>
  </h2>
  <p style="color: #666; font-size: 13px; margin: 0 0 10px 0;">${esc(video.channel)}</p>
  ${shortSummaryHtml}
  <div style="font-style: italic; color: #555; margin: 0 0 14px 0; line-height: 1.5;">${md(video.oneLiner)}</div>
  <ul style="margin: 0 0 14px 0; padding-left: 20px; line-height: 1.5;">
    ${takeaways}
  </ul>
  <p style="margin: 0; font-size: 14px;">
    <span style="color: ${verdictColor}; font-weight: bold;">${verdictIcon} ${verdictText}</span>
    &mdash; ${md(video.worthWatchingReason)}
  </p>
</div>`;
}

marked.use({
  renderer: {
    heading({ text, depth }: { text: string; depth: number }): string {
      const size = depth <= 2 ? "16px" : "14px";
      return `<p style="font-size:${size};font-weight:bold;margin:8px 0 4px 0;">${text}</p>`;
    },
  },
});

function esc(str: string): string {
  return decodeHtml(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function md(str: string): string {
  return (marked.parse(decodeHtml(str ?? "")) as string).trim();
}
