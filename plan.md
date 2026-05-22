<!--
5/22/2026 - nick decker | phase 2 completion
CHANGED
- Status updated to Phase 2 complete
- Phase 1 and Phase 2 verification checklists marked done
- Added Phase 2 bug fixes section (keyTakeaways.map fix, esc() fix)
- Added Phase 2 remaining: GitHub Actions secrets instructions

5/22/2026 - nick decker | email revisions
ADDED
- Email Revisions section documenting all changes + backfill TODO
CHANGED
- Status updated to reflect email revision work in progress
-->

# YouTube Summary — Project Plan

**Started:** 2026-05-22
**Status:** Email revisions in progress — backfill required before test

---

## The Big Hairy Audacious Goal

A daily digest system that monitors YouTube channels and topics I care about, extracts video transcripts, summarizes them with AI, and delivers the highlights to my inbox. Instead of watching 10 videos, I get a daily email telling me which ones are worth watching and why — with the key takeaways from the ones that aren't.

---

## Phases

### Phase 1 — Backend CLI ✅ COMPLETE
A TypeScript backend that fetches YouTube videos, pulls transcripts, summarizes with Claude, and stores results locally. Runs from the command line. No frontend, no email, no scheduling yet.

### Phase 2 — Automation & Personalization ✅ COMPLETE
Daily automated runs pulling from channels and topics I actually care about.

### Phase 3 — Frontend & Email (future)
A UI to manage channels/topics and a daily email digest.

---

## Decisions & Why

### Language: TypeScript (not Python)
**Decision:** TypeScript for the backend.

**Why:** The eventual frontend will be React/Next.js. One language across the whole stack means shared types, a natural path to a monorepo, and no context-switching. The `youtube-transcript` npm package is slightly less mature than the Python equivalent but reliable enough for this use case. The Anthropic SDK is excellent in both — not a differentiator.

**Tradeoff acknowledged:** Python has the more battle-tested YouTube ecosystem. We accepted that tradeoff in favor of long-term stack coherence.

---

### Video Discovery: YouTube Data API v3
**Decision:** Use the official YouTube Data API v3 via `@googleapis/youtube`.

**Why:** The only reliable, official way to programmatically fetch trending videos, channel uploads, and keyword search results. Free tier gives 10,000 units/day — enough for daily digest runs. Requires an API key from Google Cloud Console.

**What it enables:**
- `trending` mode: `videos.list` with `chart=mostPopular`
- `channel` mode: `search.list` with `channelId`, ordered by date
- `search` mode: `search.list` with keyword query

---

### Transcript Fetching: `youtube-transcript` npm package
**Decision:** Use the `youtube-transcript` npm package. No API key needed.

**Why:** YouTube exposes transcripts through their internal timedtext endpoint. This package wraps that cleanly. It works on any public video that has captions — including auto-generated ones. No authentication required, no quota concerns for transcript fetching specifically.

**Tradeoff:** Relies on an undocumented YouTube internal endpoint (same one the browser uses). Could theoretically break if YouTube changes it, but this is how the whole ecosystem works and it's been stable for years.

**What we skip:** Whisper (speech-to-text fallback). Videos with no transcript are simply skipped with a warning. We can revisit this if too many good videos are being missed.

---

### Summarization Model: Claude Haiku 4.5
**Decision:** Use `claude-haiku-4-5-20251001` for all summaries.

**Why:** Cost efficiency for bulk runs. A daily digest might summarize 10–50 videos. Haiku is fast and cheap while still producing high-quality structured output. We can swap to Sonnet for individual videos we want deeper analysis on.

**Output shape** (enforced via Claude tool use — structured JSON, not freeform):
```
{
  oneLiner: string            // one sentence: what is this video about
  keyTakeaways: string[]      // 3–5 bullet points
  worthWatching: boolean      // should I actually watch this?
  worthWatchingReason: string // one sentence explaining the verdict
}
```

---

### Long Transcript Handling: Check size → map-reduce if needed
**Decision:** Estimate token count before sending to Claude. Under 120K tokens — send directly. At or over — chunk into ~50K-token pieces, summarize each, then merge.

**Why:** Haiku has a 200K token context window. Most transcripts are 2K–30K tokens (a 2-hour video tops out around 30K tokens). The 120K threshold gives plenty of headroom. The map-reduce path only activates for genuinely long content (multi-hour conferences, full courses). This keeps the happy path dead simple and handles edge cases correctly.

**Token estimation:** `Math.ceil(wordCount * 1.35)` — conservative multiplier for English text.

---

### Storage: SQLite via `better-sqlite3`
**Decision:** SQLite with the synchronous `better-sqlite3` driver.

**Why:** Zero setup. One file. Perfect for a personal tool that isn't serving multiple concurrent users. The synchronous API is actually a feature here — the CLI pipeline is naturally sequential (fetch → transcribe → summarize → save), so async adds nothing.

**Idempotency:** `INSERT OR IGNORE` on the video ID. Re-running the same command never re-summarizes videos already in the DB. Safe to run multiple times.

**Schema carries forward:** The Phase 1 schema is designed to support Phase 3 without migration.

---

## What's Built (Phase 1)

```
youtube-summary/backend/
├── package.json              ← dependencies + npm scripts
├── tsconfig.json             ← TypeScript config (ESM, NodeNext)
├── .env.example              ← template for required API keys
├── .gitignore                ← excludes node_modules, .env, *.db
└── src/
    ├── index.ts              ← CLI entry: parses args, orchestrates the pipeline
    ├── youtube.ts            ← YouTube Data API: getTrending / getChannelVideos / searchVideos
    ├── transcript.ts         ← Transcript fetch + token estimation + map-reduce chunking
    ├── summarizer.ts         ← Claude Haiku: summarize() with structured tool-use output
    └── db.ts                 ← SQLite: init schema, isAlreadySummarized, saveVideo, listVideos
```

### CLI Usage
```bash
# from youtube-summary/backend/
npx tsx src/index.ts trending                        # 5 trending videos (US)
npx tsx src/index.ts trending --category 28          # Science & Tech category
npx tsx src/index.ts trending --n 10                 # fetch more
npx tsx src/index.ts channel UCxxxxxxxxxxxxxxxx      # latest from a channel
npx tsx src/index.ts search "AI agents"              # keyword search
```

---

## Verification Checklist (Phase 1) ✅ ALL PASSED 2026-05-22

- [x] `npx tsx src/index.ts trending` — 5 videos fetched, transcribed, summarized, saved
- [x] Re-run same command — no re-processing ("already in DB" skips shown)
- [x] `npx tsx src/index.ts channel <id>` — channel-specific results
- [x] `npx tsx src/index.ts search "TypeScript"` — keyword results
- [x] `sqlite3 data/summaries.db "SELECT id, title, one_liner FROM videos;"` — rows present

## Verification Checklist (Phase 2) ✅ ALL PASSED 2026-05-22

- [x] `npm run digest` — channels and topics fetched, 24h cutoff applied, new videos summarized
- [x] Email delivered to nickdeckerdevs@gmail.com via Resend
- [x] Idempotency — re-run skips already-processed videos
- [x] GitHub Actions workflow fires daily at 7am CT (manual trigger also available via GitHub UI)

## Phase 2 Bugs Fixed

- **`keyTakeaways.map is not a function`** — Claude tool_use response cast with `as` without runtime validation; `key_takeaways` could be non-array. Fixed in `summarizer.ts`: `Array.isArray` check + filter for string elements only.
- **`Cannot read properties of undefined (reading 'replace')`** — `esc()` in `mailer.ts` called on undefined field from API response. Fixed with `(str ?? "")` null-coalescing guard.

## Phase 2 Remaining — GitHub Secrets

The GitHub Actions workflow is committed and ready. To activate scheduled runs, add these secrets to the repo at **Settings → Secrets and variables → Actions**:

| Secret | Value |
|--------|-------|
| `YOUTUBE_API_KEY` | from Google Cloud Console |
| `ANTHROPIC_API_KEY` | from Anthropic Console |
| `RESEND_API_KEY` | from Resend dashboard |
| `DIGEST_TO_EMAIL` | nickdeckerdevs@gmail.com |

---

## Phase 2 — Automation & Personalization (Design Notes)

**Goal:** Run daily automatically, from channels and topics I actually care about.

**Channel/Content Source — likely approach:**
- Start with a `config.json` file listing channel IDs and search keywords I manage manually. No OAuth, easy to version-control.
- Add YouTube OAuth later *only if* maintaining the list manually becomes annoying. OAuth pulls actual subscriptions automatically but adds complexity (Google Cloud OAuth consent screen, token refresh).

**Scheduling — options:**
- **System cron** (simplest): `crontab -e` → run the CLI at 6am daily. Works, but requires the machine to be on.
- **node-cron** (in-process): Long-running Node process with internal scheduler. Good for a VPS.
- **Cloud scheduler** (best long-term): GitHub Actions scheduled workflow, Railway cron, or Render cron. Machine doesn't need to be on.
- Likely path: system cron for local testing → cloud scheduler when we want it running reliably every day.

**Email Delivery — likely pick: Resend**
- Resend: best developer experience, TypeScript SDK, 3,000 free emails/month, clean API
- SendGrid: higher free tier (100/day), more complex
- Nodemailer + SMTP: self-hosted, no vendor dependency

**Email format:** HTML digest — one section per video. Title, channel, one-liner, key takeaways as bullets, worth-watching verdict with reason. Link to the actual YouTube video. Sent once daily.

---

---

## Email Revisions (2026-05-22)

### What Changed
- **HTML entity decoding** — YouTube API returns raw HTML entities (`&#39;`, `&amp;`, etc.) in text fields. Added `decodeHtml()` in `youtube.ts` applied to all title, channel, and description fields before storage.
- **Thumbnail URLs** — `medium` thumbnail (320×180) now captured from YouTube API in all fetch functions (`getTrending`, `getChannelVideos`, `searchVideos`, `getPlaylistVideos`). Stored as `thumbnail_url` in DB. Rendered as an `<img>` tag in email.
- **Short summary** — New `short_summary` field (2-3 sentences) added to the Claude tool schema. Stored separately from `oneLiner` in DB. Displayed below the title/channel in the email, above the one-liner.
- **Test email script** — `npm run test-email` pulls 5 random DB rows and sends a digest email. Used to verify template changes without waiting for fresh 24h videos.
- **Future** (Phase 3): title link in email will point to the Tube Chew frontend summary page. Placeholder noted in `mailer.ts`.

### Backfill Required — Before Next Test

Existing DB rows (32+) were saved before `short_summary` and `thumbnail_url` columns existed. A backfill is needed:

- [ ] **`thumbnail_url` backfill** — call `videos.list` with existing video IDs, update rows with medium thumbnail URL
- [ ] **`short_summary` backfill** — generate 2-3 sentence summary from existing `one_liner` + `key_takeaways` using Claude (transcripts not stored, so we synthesize from existing data)

Once backfill runs, `npm run test-email` will show the full updated email format.

### Schema Migration
`thumbnail_url TEXT` and `short_summary TEXT` columns added via `ALTER TABLE` (nullable, idempotent — safe to run on existing DB).

---

## Phase 3 — Frontend & Configuration UI (Design Notes)

**Goal:** Manage channels/topics and browse summaries without editing config files.

**Stack — likely: Next.js**
- Full-stack TypeScript. API routes + React in one repo.
- Same language as the backend — natural monorepo.
- Alternative: SvelteKit (lighter) if simplicity matters more than ecosystem.

**UI features to build:**
- **Channel manager** — add/remove channels by URL or ID, toggle enabled/disabled
- **Topic/keyword manager** — manage search queries that run alongside channels
- **Summary browser** — paginated, filterable list of past summaries with expand + video link
- **Settings panel** — videos per run, email address, send time, on/off toggle
- **Watch history** — mark videos as watched or interesting; feed into future prioritization

**API layer:** Next.js API routes reading from the same SQLite DB via `better-sqlite3`. The Phase 1 schema was designed to carry forward without migration.
