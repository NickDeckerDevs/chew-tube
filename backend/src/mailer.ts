/*
5/23/2026 - nick decker | hideSkipped filter
CHANGED
- `sendDigestEmail` accepts new optional `hideSkipped` param (default false)
- When true, filters out videos with verdict="skip" or worthWatching=false before building the email

5/22/2026 - nick decker | verdict algorithm v2
CHANGED
- Verdict display updated to 3-tier: watch (green) / conditional (amber) / skip (red)
- Verdict detail (verdictDetail) rendered instead of worthWatchingReason when available
- Clickbait flag renders as a small warning badge if present
- Top 2 comments rendered below verdict when available

5/22/2026 - nick decker | email trim
CHANGED
- Removed short summary, one-liner, and key takeaways from email — stored in DB but not rendered
- Email now shows: thumbnail → title → channel → verdict + reason only

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

5/22/2026 - nick decker | refactor + template update
CHANGED
- Verdict (skip/watch + reason) moved to appear immediately after title and channel, before short summary and detailed content
*/

import { marked } from "marked";
import { Resend } from "resend";
import type { StoredVideo } from "./db.js";
import { decodeHtml } from "./utils.js";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendDigestEmail(videos: StoredVideo[], to: string, subjectPrefix?: string, hideSkipped = false): Promise<void> {
  if (hideSkipped) videos = videos.filter((v) => v.verdict !== "skip" && v.worthWatching !== false);
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const subject = subjectPrefix
    ? `[${subjectPrefix}] YouTube Digest — ${date}`
    : `YouTube Digest — ${date}`;

  await resend.emails.send({
    from: "Tube Chew <onboarding@resend.dev>",
    to,
    subject,
    html: buildHtml(videos, date, subjectPrefix),
  });
}

function buildHtml(videos: StoredVideo[], date: string, label?: string): string {
  const sections = videos.map(buildVideoSection).join("\n");
  const count = `${videos.length} video${videos.length === 1 ? "" : "s"}${label ? ` — ${label}` : ""}`;

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

function verdictDisplay(video: StoredVideo): { color: string; text: string; icon: string } {
  // Prefer v2 verdict field; fall back to binary worth_watching for old rows
  const tier = video.verdict;
  if (tier === "watch") return { color: "#2e7d32", text: "Watch it", icon: "✓" };
  if (tier === "conditional") return { color: "#e65100", text: "Watch if...", icon: "◐" };
  if (tier === "skip") return { color: "#c62828", text: "Skip it", icon: "✗" };
  // old row fallback
  return video.worthWatching
    ? { color: "#2e7d32", text: "Worth watching", icon: "✓" }
    : { color: "#c62828", text: "Skip it", icon: "✗" };
}

function buildVideoSection(video: StoredVideo): string {
  const url = `https://youtube.com/watch?v=${video.id}`;
  const { color, text, icon } = verdictDisplay(video);
  const reason = video.verdictDetail ?? video.worthWatchingReason;

  const thumbnail = video.thumbnailUrl
    ? `<img src="${video.thumbnailUrl}" width="320" alt="" style="width:100%;max-width:320px;height:auto;display:block;margin-bottom:12px;border-radius:4px;">`
    : "";

  const clickbaitBadge = video.clickbait
    ? `<span style="display:inline-block;margin-left:8px;padding:1px 6px;background:#fff3e0;border:1px solid #ffb74d;border-radius:3px;font-size:11px;color:#e65100;">⚠ Clickbait</span>`
    : "";

  const commentsHtml = video.topComments && video.topComments.length > 0
    ? `<div style="margin-top:12px;border-top:1px solid #f0f0f0;padding-top:10px;">
    <p style="margin:0 0 6px 0;font-size:11px;color:#999;text-transform:uppercase;letter-spacing:0.5px;">Top comments</p>
    ${video.topComments.map((c) => `<div style="margin-bottom:8px;font-size:13px;color:#444;">
      <span style="font-weight:bold;color:#555;">${esc(c.author)}</span>
      <span style="color:#999;font-size:11px;margin-left:6px;">👍 ${c.likes}</span>
      <div style="margin-top:2px;line-height:1.5;">${esc(c.text)}</div>
    </div>`).join("")}
  </div>`
    : "";

  return `<div style="margin-bottom: 28px; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
  ${thumbnail}
  <h2 style="margin: 0 0 4px 0; font-size: 17px; line-height: 1.3;">
    <a href="${url}" style="color: #0066cc; text-decoration: none;">${esc(video.title)}</a>
    ${clickbaitBadge}
  </h2>
  <p style="color: #666; font-size: 13px; margin: 0 0 8px 0;">${esc(video.channel)}</p>
  <p style="margin: 0; font-size: 14px;">
    <span style="color: ${color}; font-weight: bold;">${icon} ${text}</span>
    &mdash; ${md(reason)}
  </p>
  ${commentsHtml}
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
