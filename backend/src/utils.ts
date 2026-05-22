/*
5/22/2026 - nick decker | db utility + email revisions
ADDED
- `decodeHtml()` — shared HTML entity decoder, previously duplicated in youtube.ts and mailer.ts
*/

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
