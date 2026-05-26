<!--
5/25/2026 - nick decker | Supabase migration decision + product vision
ADDED
- Product Vision section (long-term content platform direction)
- Phase 2.5 — Database Migration section (full migration scope)
CHANGED
- Storage architecture decision updated: SQLite → Supabase
- Phase 3 design notes updated: SQLite/better-sqlite3 → Supabase/Drizzle, auth flow added, semantic search added
- "Remaining Before Phase 3" replaced with actionable checklist (algorithm items + migration steps)
- File tree updated to note SQLite and db.ts are being replaced
- Status line updated

5/23/2026 - nick decker | integer scorer phase 1
CHANGED
- Algorithm Development checklist: integer scoring Phase 1 marked complete
- Explicit persona match signals (persona_match + channel_categories_matched) noted as complete
- Integer scoring item updated to show Phase 1 done, Phases 2–4 remaining

5/22/2026 - nick decker | phase 2 completion
CHANGED
- Status updated to Phase 2 complete
- Phase 1 and Phase 2 verification checklists marked done
- Added Phase 2 bug fixes section
- Added Phase 2 remaining: GitHub Actions secrets instructions

5/22/2026 - nick decker | email revisions
ADDED
- Email Revisions section documenting all changes + backfill TODO
CHANGED
- Status updated to reflect email revision work in progress

5/22/2026 - nick decker | doc catch-up
CHANGED
- Status updated to current: email revisions complete, refactors done, pending GitHub secrets
- Backfill TODO items marked complete
- "What's Built" expanded to cover all Phase 2+ files
- Added Email Revisions (complete) section
- Added DB Utilities section
- Added Refactors section
- Old Phase 2 design notes converted to "How It Was Built" for reference
- Phase 3 description updated (email is done; frontend is the remaining phase)
-->

# YouTube Summary — Project Plan

**Started:** 2026-05-22
**Status:** Active algorithm development — Phase 2 complete, Supabase migration planned (Phase 2.5), Phase 3 frontend after migration

---

## The Big Hairy Audacious Goal

A daily digest system that monitors YouTube channels and topics I care about, extracts video transcripts, summarizes them with AI, and delivers the highlights to my inbox. Instead of watching 10 videos, I get a daily email telling me which ones are worth watching and why — with the key takeaways from the ones that aren't.

---

## Product Vision

This is being built as a personal tool first, tuned between the developer and a small group of friends, then launched as a product.

**Long-term direction:** A better way to consume content — not just YouTube. The roadmap includes:
- News integration (RSS, newsletters, major outlets) — same summarize/score/filter pipeline applied to articles
- Paywall detection and filtering — surface only freely accessible content
- Unified feed across sources — YouTube + news + podcasts in one ranked digest
- Personalized discovery — not just email, but a browsable feed (think Google News but with real curation and no SEO garbage)
- Semantic search across all content via pgvector — "what happened with X this week" as a query, not a keyword filter
- Content deduplication — detect when 40 YouTube shorts and 20 news articles all cover the same story; surface one representative item

The database and auth architecture decisions are made with this trajectory in mind, not just the current feature set.

---

## Phases

### Phase 1 — Backend CLI ✅ COMPLETE
A TypeScript backend that fetches YouTube videos, pulls transcripts, summarizes with Claude, and stores results locally. Runs from the command line. No frontend, no email, no scheduling yet.

### Phase 2 — Automation & Personalization ✅ COMPLETE
Daily automated runs pulling from channels and topics I actually care about. Includes email delivery, scheduling via GitHub Actions, and all post-launch email polish.

### Phase 2.5 — Database Migration (next)
Migrate from SQLite to Supabase (Postgres + Auth + pgvector). Must happen before Phase 3. See the Phase 2.5 section below for full scope.

### Phase 3 — Frontend (after Phase 2.5)
A web UI to manage channels/topics and browse past summaries. Email is already working — this phase is purely the frontend.

---

## Architecture Decisions

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
- `playlist` mode: `playlistItems.list`
- `resolve` mode: `channels.list` with `forHandle` to convert @handles to IDs

---

### Transcript Fetching: `youtube-transcript` npm package
**Decision:** Use the `youtube-transcript` npm package. No API key needed.

**Why:** YouTube exposes transcripts through their internal timedtext endpoint. This package wraps that cleanly. It works on any public video that has captions — including auto-generated ones. No authentication required, no quota concerns for transcript fetching specifically.

**Tradeoff:** Relies on an undocumented YouTube internal endpoint (same one the browser uses). Could theoretically break if YouTube changes it, but this is how the whole ecosystem works and it's been stable for years.

**What we skip:** Whisper (speech-to-text fallback). Videos with no transcript are simply skipped with a warning.

---

### Summarization Model: Claude Haiku 4.5
**Decision:** Use `claude-haiku-4-5-20251001` (constant: `HAIKU_MODEL` in `utils.ts`) for all summaries.

**Why:** Cost efficiency for bulk runs. A daily digest might summarize 10–50 videos. Haiku is fast and cheap while still producing high-quality structured output. We can swap to Sonnet for individual videos we want deeper analysis on.

**Output shape** (enforced via Claude tool use — structured JSON, not freeform):
```
{
  oneLiner: string            // one sentence: what is this video about
  shortSummary: string        // 2-3 sentence digest preview
  keyTakeaways: string[]      // 3–5 bullet points
  worthWatching: boolean      // should I actually watch this?
  worthWatchingReason: string // one sentence explaining the verdict
}
```

---

### Long Transcript Handling: Check size → map-reduce if needed
**Decision:** Estimate token count before sending to Claude. Under 120K tokens — send directly. At or over — chunk into ~50K-token pieces, summarize each, then merge.

**Why:** Haiku has a 200K token context window. Most transcripts are 2K–30K tokens. The 120K threshold gives plenty of headroom. The map-reduce path only activates for genuinely long content (multi-hour conferences, full courses).

**Token estimation:** `Math.ceil(wordCount * 1.35)` — conservative multiplier for English text.

---

### Queue Architecture: Producer / Worker split via SQLite queue table

**Decision:** Add a `queue` table to the existing SQLite DB as a persistent job queue. Split video processing into two separate scripts — a fast producer that fetches and transcribes, and a rate-controlled worker that calls Claude.

**Why:** The synchronous pipeline (fetch → transcribe → summarize → save) hits Anthropic's 50k input tokens/minute rate limit when processing many videos in bulk. Transcription has no API rate limits; only Claude calls do. Separating them means the producer runs at full speed while the worker self-throttles.

**Producer (`queue-fill`):**
- Iterates all sources (trending, categories, keyword searches)
- Fetches video lists, pulls transcripts
- Inserts transcribable videos into the `queue` table with `status = 'pending'`
- No Claude calls — runs in seconds per source
- Skips videos already in `videos` table (already scored) or already in queue

**Worker (`queue-work`):**
- Dequeues one `pending` item at a time (atomic SELECT + UPDATE to prevent double-processing)
- Calls Claude, saves result to `videos` table, marks queue item `done`
- Fixed 15-second delay between Claude calls → ~4 calls/min → ~40k tokens/min (safely under 50k limit)
- Retry-with-backoff in `summarizer.ts` handles edge-case 429s
- On startup, resets any `processing` items back to `pending` (crash recovery)
- Saves dated results JSON + updates manifest when queue drains

**Queue table schema:**
```sql
CREATE TABLE queue (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  channel       TEXT NOT NULL,
  description   TEXT,
  thumbnail_url TEXT,
  published_at  TEXT,
  transcript    TEXT NOT NULL,
  chunked       INTEGER NOT NULL DEFAULT 0,
  source_type   TEXT NOT NULL,
  source_label  TEXT,
  channel_label TEXT,
  queued_at     TEXT NOT NULL DEFAULT (datetime('now')),
  status        TEXT NOT NULL DEFAULT 'pending',
  started_at    TEXT,
  completed_at  TEXT,
  error         TEXT
)
```

**Tradeoff acknowledged:** Fixed delay means the worker is intentionally slower than it could be. A token-bucket approach (tracking actual usage per minute) would be more efficient but adds complexity. The fixed delay is simple, predictable, and safe.

---

### Algorithm: 3-Tier Verdict + Parallel Integer Scoring (in development)

**Decision:** Claude returns a 3-tier verdict (`watch` / `conditional` / `skip`) via `tool_use`. A parallel integer scoring system is being built alongside it — both will be shown in the digest email for calibration. See `algorithm.md` for full design.

**What feeds the verdict today:**
- Stated persona string (from `config.settings.persona`)
- Channel-derived persona profile (from `persona-profile.json`, built by `build-persona.ts`)
- Source type signal — channel-sourced videos get a higher bar than search/trending
- Clickbait detection — title vs. transcript mismatch flagged as boolean + reason
- Per-channel profile — injected for known channels

**Integer scoring (planned, not yet built):**
- Baseline: channel source +5, trending/search 0
- Stated persona match: strong +10, partial +5
- Channel-derived persona match: 3+ categories +10, 2 categories +6, 1 category +3
- Category preference modifier: 1–5 score from `categoryPreferences` acts as multiplier on persona points
- Clickbait: −10; total negative cap: −20
- Thresholds for watch/conditional/skip TBD after first parallel run

**Music — own scoring path (planned):**
Music videos (detected by `topicCategories` containing a music genre label) skip the transcript-based verdict entirely. Scored via `musicPreferences` config: genre match, sub-genre thematic similarity, and artist comparison via LLM. See `algorithm.md`.

**Baseline test results (2026-05-23, 886 videos):** 30% watch / 5% conditional / 65% skip overall. Keyword searches (~75–95% watch) outperform category trending significantly. Category preferences not yet active — car videos passing despite Autos rated 1★.

---

### Topic Labels Collection

**Decision:** Every time `getVideoSignals()` or `getTrending()` runs, decoded YouTube topic category labels are upserted into a `topic_labels` table (`label`, `url`, `count`, `first_seen`). This passively builds a complete catalogue of every topic YouTube uses across all runs.

**Why:** Phase 3 needs a source of truth for the category/genre picker UI. Rather than hardcoding a list, we accumulate the real taxonomy from live API responses. By the time the frontend is built, the table will be populated.

---

### Storage: Supabase (Postgres + Auth + pgvector)
**Decision:** Migrate from SQLite to Supabase. Decided 2026-05-25.

**Why SQLite is being replaced:**
- Flat file — not appropriate for a product
- No persistence in CI — every GitHub Actions run starts with an empty DB, breaking deduplication
- No auth — can't build a multi-user frontend on top of it
- No vector search — can't do semantic content discovery without pgvector

**Why Supabase:**
- Real Postgres underneath — full SQL, relational, battle-tested
- Auth is built in (email, Google, GitHub, magic links, MFA) — tied to data via Row Level Security at the DB layer, not the application layer
- pgvector built in — embeddings can be added to the `videos` table so summaries become semantically searchable. This is the feature that turns a digest into a discovery engine
- Realtime subscriptions — new content can push to browser without polling
- Excellent Next.js integration via `@supabase/ssr`
- Open source — self-hostable if needed
- Free tier: 500MB DB, 50k MAU, 1GB storage. Daily cron keeps DB active (no inactivity pause risk)
- $25/mo Pro tier when ready to scale

**Current status:** SQLite (`backend/src/db.ts` via `better-sqlite3`) is still in place. Migration is Phase 2.5.

**pgvector decision:** Enable from day one. Add empty `embedding vector(1536)` column to the `videos` table at migration time. Populate embeddings as a background job later. Avoids a schema migration when semantic search is built.

**Idempotency in Postgres:** `ON CONFLICT (id) DO NOTHING` replaces SQLite's `INSERT OR IGNORE`.

---

### Email Delivery: Resend
**Decision:** Resend for all outbound email.

**Why:** Best developer experience, TypeScript SDK, 3,000 free emails/month, clean API. Email template is pure inline-styled HTML for email client compatibility. Markdown in AI-generated fields is converted to HTML via `marked`.

---

### Scheduling: GitHub Actions
**Decision:** GitHub Actions cron workflow (`0 10 * * *` — 5am EST / 6am EDT).

**Why:** Machine doesn't need to be on. Free for public repos. `workflow_dispatch` allows manual runs from the GitHub UI without touching the terminal.

**Known issue:** GitHub's scheduler can delay runs by up to several hours under load. With a 24h rolling cutoff, a 3.5h delay means content published before the delayed run time falls outside the window and gets missed. This is resolved by the Supabase migration — a persistent cloud DB allows the cutoff to be based on the last actual run timestamp rather than a fixed 24h window.

---

## Phase 2.5 — Database Migration

Migrate from SQLite to Supabase. Must happen before Phase 3 so the frontend starts on the right foundation.

**Why before frontend:**
- Frontend auth requires Supabase Auth
- Next.js API routes will read from Postgres, not SQLite
- CI deduplication only works with a persistent DB — Supabase solves this without workarounds
- pgvector needs to be in place before embeddings work begins

**Migration scope:**

| Item | Current (SQLite) | Target (Postgres) |
|------|-----------------|-------------------|
| Client | `better-sqlite3` (sync) | `drizzle-orm` + `postgres` (async) |
| All `db.ts` functions | Synchronous | Must become `async` — pervasive change |
| Booleans | Stored as `1`/`0` INT | `BOOLEAN` columns, pass `true`/`false` |
| JSON fields | `JSON.stringify()` to TEXT | `JSONB` columns, pass plain objects |
| `INSERT OR IGNORE` | SQLite syntax | `ON CONFLICT (id) DO NOTHING` |
| `datetime('now')` | SQLite function | `NOW()` |
| Transactions | Sync callback | Async callback |
| Dequeue pattern | SELECT then UPDATE | `FOR UPDATE SKIP LOCKED` (concurrent-safe) |
| Parameterized queries | `?` / `@name` | Drizzle handles abstraction |
| Migrations | `ALTER TABLE` in JS | SQL files via `drizzle-kit` |

**JSON columns to convert to JSONB:** `takeaways`, `top_comments`, `topic_categories`, `score_breakdown`

**New columns to add at migration:**
- `embedding vector(1536)` — pgvector, initially empty, populated later as a background job

**New dependencies:**
```bash
npm install drizzle-orm postgres @supabase/supabase-js
npm install -D drizzle-kit
```

**New environment variables:**
```
SUPABASE_URL=https://[project-ref].supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...    # backend scripts only — bypasses RLS
NEXT_PUBLIC_SUPABASE_URL=...         # Next.js frontend (safe to expose)
NEXT_PUBLIC_SUPABASE_ANON_KEY=...    # Next.js frontend (safe to expose, RLS enforces access)
DATABASE_URL=postgresql://...        # Drizzle runtime queries (session pooler, port 5432)
DATABASE_URL_DIRECT=postgresql://... # Drizzle migrations only (direct connection)
```

**Supabase connection modes:**
- Port 5432 session pooler — backend cron scripts (long-lived Node process)
- Port 6543 transaction pooler — Next.js API routes / serverless (session mode on 6543 deprecated 2025-02-28)
- Direct connection — `drizzle-kit` migrations only

**Auth design:**
Supabase Auth handles email, Google OAuth, magic links, MFA. Row Level Security (RLS) ties auth to data at the DB layer. Beta launch (developer + friends): email auth. Before public launch: add Google OAuth.

Next.js middleware (`middleware.ts`) refreshes auth tokens on every request via `@supabase/ssr`. Must use `getUser()` not `getSession()` server-side — `getSession()` does not re-validate the JWT against Supabase's servers and can be spoofed.

**Files that change:**
- `backend/src/db.ts` — full rewrite (Drizzle schema + async functions)
- `backend/src/digest.ts` — all db calls become `await`
- `backend/src/queue-work.ts` — all db calls become `await`
- `backend/src/queue-fill.ts` — all db calls become `await`
- `backend/src/index.ts` — all db calls become `await`
- `backend/src/summarizer.ts` — db calls become `await`
- `backend/src/mailer.ts` — no change (no direct DB access)
- `backend/src/scorer.ts` — no change (pure math, no DB)
- `backend/.env.example` — add Supabase vars
- `.github/workflows/daily-digest.yml` — add Supabase secrets; replace 24h cutoff with last-run timestamp from DB
- `backend/package.json` — add drizzle-orm, postgres, @supabase/supabase-js; remove better-sqlite3
- `backend/src/db.test.ts` — in-memory SQLite tests need rethinking (test Supabase project or Drizzle mock)

---

## What's Built

```
youtube-summary/
├── plan.md
├── algorithm.md                ← living algorithm design doc (verdicts, scoring, music path)
├── README.md
├── data/
│   ├── summaries.db            ← SQLite database (gitignored) — to be replaced by Supabase (Phase 2.5)
│   ├── index.html              ← algo-test report viewer (served via `npm run report`)
│   └── results/                ← dated JSON results from algo-test runs + manifest.json
├── .github/
│   └── workflows/
│       └── daily-digest.yml    ← GitHub Actions cron (5am EST daily), Node 24
└── backend/
    ├── package.json            ← deps + npm scripts
    ├── tsconfig.json
    ├── .env.example
    ├── config.json             ← channels, topics, categoryPreferences, musicPreferences
    ├── persona-profile.json    ← generated by build-persona; channel + category summaries
    └── src/
        ├── utils.ts            ← shared: decodeHtml, HAIKU_MODEL, getAnthropicClient, runScript
        ├── db.ts               ← SQLite: schema, CRUD, topic_labels table — to be replaced by Drizzle + Supabase (Phase 2.5)
        ├── youtube.ts          ← YouTube API: all fetch modes, getVideoSignals, getTrending w/ topicDetails
        ├── transcript.ts       ← transcript fetch, token estimation, map-reduce chunking
        ├── summarizer.ts       ← Claude Haiku: 3-tier verdict, persona injection, clickbait detection
        ├── mailer.ts           ← Resend: HTML digest email with markdown rendering
        ├── build-persona.ts    ← generates persona-profile.json from configured channels
        ├── index.ts            ← CLI entry: all modes, pretty terminal output
        ├── digest.ts           ← automated digest runner (reads config.json, 24h cutoff, Shorts filter)
        ├── queue-fill.ts       ← producer: fetches + transcribes all sources into queue table
        ├── queue-work.ts       ← worker: dequeues one at a time, calls Claude at 15s intervals
        ├── algo-test.ts        ← runs verdict pipeline across 24 sources, saves dated results
        ├── rescore.ts          ← re-runs verdict on existing DB rows (control set testing)
        ├── test-email.ts       ← sends 5 random DB rows as a test digest
        ├── backfill.ts         ← one-shot: fill missing thumbnail_url and short_summary
        └── fix-titles.ts       ← one-shot: decode HTML entities in stored title/channel fields
```

### npm scripts
```bash
npm run digest        # run the full daily digest pipeline
npm run queue-fill    # producer: fetch + transcribe all sources into queue
npm run queue-work    # worker: process queue with Claude (15s delay between calls)
npm run algo-test     # run verdict pipeline across 24 sources, save dated results
npm run build-persona # generate persona-profile.json from configured channels
npm run report        # serve algo-test report viewer at localhost:3456
npm run test-email    # send 5 random DB rows as a test digest email
npm run backfill      # fill thumbnail_url + short_summary for existing rows
npm run fix-titles    # decode HTML entities in stored title/channel fields
npm start             # CLI mode (same as npx tsx src/index.ts)
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
- [x] GitHub Actions workflow committed and ready (`daily-digest.yml`)
- [x] `npm run test-email` — test email sent with 5 random DB rows, verified in inbox
- [x] Thumbnails present in email (320×180)
- [x] Short summary renders as plain prose below title
- [x] Verdict (skip/watch + reason) appears immediately after title/channel
- [x] No HTML entities in email output
- [x] Markdown in AI fields converts to HTML correctly via `marked`

---

## Bugs Fixed (Phase 2)

- **`keyTakeaways.map is not a function`** — Claude tool_use response cast with `as` without runtime validation. Fixed in `summarizer.ts`: `Array.isArray` check + filter for string elements only.
- **`Cannot read properties of undefined (reading 'replace')`** — `esc()` called on undefined API field. Fixed with `(str ?? "")` null-coalescing guard.
- **HTML entity double-encoding** — stored titles had raw `&#39;` etc from YouTube API. Fixed: `decodeHtml()` applied before `esc()` in mailer; `fix-titles.ts` script cleans existing rows; `youtube.ts` decodes at fetch time for all new rows.
- **Markdown headings in short summaries** — Claude occasionally returned `# Heading` in free-form text. Fixed: `marked` with a custom email-safe heading renderer converts to styled `<p>` tags; prompts updated to say "plain prose only."

---

## DB Utilities

- **`updateVideoColumn(id, column, value)`** — type-safe single-column UPDATE. Column name validated against a const allowlist (`UPDATEABLE_COLUMNS`) to prevent SQL injection. Use for any post-insert field corrections.
- **`getDb()`** — exported so one-shot scripts can reuse the shared connection + auto-migration instead of opening their own.
- **`getRandomVideos(n)`** — returns `n` random `StoredVideo` rows. Used by `test-email.ts`.
- **`mapRowToVideo(r)`** — private helper that maps a raw DB row to `StoredVideo`. Single source of truth for both `getRandomVideos` and `listVideos`.

---

## Refactors Completed (2026-05-22)

All findings from automated code review applied:

| What | Where | Change |
|------|-------|--------|
| Duplicate row mapping | `db.ts` | Extracted `mapRowToVideo()` |
| `getDb()` private→exported | `db.ts` | Backfill scripts reuse connection + migration |
| Duplicate YouTube client | `backfill.ts` ← `youtube.ts` | `getYouTube()` exported and shared |
| Duplicate Anthropic client | `summarizer.ts` + `backfill.ts` | `getAnthropicClient()` in `utils.ts` |
| Hardcoded model string | `summarizer.ts` + `backfill.ts` | `HAIKU_MODEL` constant in `utils.ts` |
| Script boilerplate | 3 scripts | `runScript(fn)` in `utils.ts` |
| Inline `Summary` type | `index.ts` | Import `Summary` from `db.ts` |
| `decodeHtml` duplication | `youtube.ts` + `mailer.ts` | Moved to `utils.ts`, imported everywhere |

---

## Algorithm Development — In Progress (2026-05-23)

See `algorithm.md` for full design. Items completed this session:

- [x] 3-tier verdict (watch/conditional/skip) with clickbait detection
- [x] Persona injection — stated + channel-derived via `build-persona.ts`
- [x] `categoryPreferences` (1–5) stored in config — modifier formula TBD
- [x] `musicPreferences` config — genres, subGenres, artists
- [x] `categoryId` + `topicCategories` captured per video in DB
- [x] `topic_labels` table accumulates YouTube genre taxonomy automatically
- [x] Shorts filter in `queue-fill.ts` (was already in `digest.ts`)
- [x] Queue architecture — `queue-fill` + `queue-work` producer/worker split
- [x] Algo-test framework — 24 sources, dated results, HTML report viewer
- [x] Wire `categoryPreferences` into summarizer — category score (1–5) now injected into Claude system prompt per video; resolves from video's actual `categoryId` with source-level interestScore as fallback; affects digest, queue-work, and algo-test
- [x] Integer scoring Phase 1 — explicit persona match signals: `persona_match` ("strong"/"partial"/"none") and `channel_categories_matched` (0–3) added to Claude tool schema as independent fields; stored in DB as `persona_match` + `channel_categories_matched` columns
- [x] Integer scoring Phase 2 — `scorer.ts`: `computeScore(signals, sourceType, categoryScore)` — baseline + stated persona + channel persona (both scaled by category multiplier) + clickbait penalty; returns `{ score, breakdown }`
- [x] Integer scoring Phase 3 — `score` + `score_raw` + `score_penalty` + `score_breakdown` DB columns; digest.ts and queue-work.ts compute and store all fields after summarization
- [x] Integer scoring Phase 4 — score line in digest email: net score, raw, penalty; penalty turns red when > 0; net score turns red when negative; hidden on old rows without score data
- [x] Test suite — Vitest; 22 tests across `scorer.test.ts` (15 tests, pure math) and `db.test.ts` (7 tests, in-memory SQLite); caught real bug in `upsertTopicLabels` (double-count on first insert, fixed with `ON CONFLICT DO UPDATE`)
- [ ] Music genre scoring path — own logic, no transcript required
- [ ] Negative signals (second −10) — deferred until post-use observation
- [ ] Integer score thresholds — TBD after first parallel run

---

## Remaining Before Phase 3

### Algorithm items (finish on SQLite before migration)
- [ ] Music genre scoring path — own logic, no transcript required (see `algorithm.md`)
- [ ] Integer score thresholds — TBD after observing parallel run data
- [ ] Negative signals (second −10) — deferred until post-use observation

### Phase 2.5 — Supabase migration (do before frontend)
See the Phase 2.5 section above for full scope.

- [ ] Create Supabase project
- [ ] Enable pgvector extension in Supabase dashboard (Database → Extensions → vector)
- [ ] Write Drizzle schema (`backend/src/schema.ts`) mapping current SQLite tables to Postgres
- [ ] Run initial migration via `drizzle-kit` — includes `embedding vector(1536)` column
- [ ] Migrate existing data from `data/summaries.db` to Supabase (one-shot script)
- [ ] Rewrite `backend/src/db.ts` — Drizzle ORM, async, JSONB, correct SQL syntax
- [ ] Update all callers to `await` db functions
- [ ] Update `.env.example` and GitHub Actions secrets
- [ ] Update CI workflow — add Supabase env vars; replace 24h cutoff with last-run timestamp from DB
- [ ] Update `db.test.ts` — replace in-memory SQLite tests (test Supabase project or Drizzle mock)
- [ ] Verify digest pipeline end-to-end against Supabase

### GitHub Actions secrets
✅ Already set: `YOUTUBE_API_KEY`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `DIGEST_TO_EMAIL`, `DIGEST_LOG_EMAIL`

Pending (add after Supabase project created):
- [ ] `SUPABASE_URL`
- [ ] `SUPABASE_SERVICE_ROLE_KEY`
- [ ] `DATABASE_URL` (session pooler)

---

## Refactor Candidates (Next Refactor Pass)

Any function over 15 lines flagged for review. Not all need splitting — some are fine — but each should be evaluated.

| File | Function | Lines |
|------|----------|-------|
| algo-test.ts | processSource | 60 |
| algo-test.ts | main | 77 |
| backfill.ts | backfillThumbnails | 28 |
| backfill.ts | backfillShortSummaries | 38 |
| benchmark-playlist.ts | main | 44 |
| build-persona.ts | resolveAndPersistMissingPlaylistIds | 24 |
| build-persona.ts | main | 111 |
| db.ts | getDb | 30 |
| db.ts | saveVideo | 33 |
| db.ts | mapRowToVideo | 21 |
| digest.ts | processVideo | 38 |
| digest.ts | main | 61 |
| fix-titles.ts | main | 28 |
| index.ts | parseArgs | 31 |
| index.ts | fetchVideos | 25 |
| index.ts | printSummary | 16 |
| index.ts | main | 93 |
| mailer.ts | sendDigestEmail | 20 |
| mailer.ts | buildHtml | 21 |
| mailer.ts | buildVideoSection | 38 |
| rescore.ts | main | 49 |
| send-before.ts | main | 18 |
| summarizer.ts | buildSystemPrompt | 23 |
| summarizer.ts | callSummaryTool | 50 |
| summarizer.ts | summarizeChunks | 31 |
| summarizer.ts | summarize | 22 |
| test-topics.ts | main | 71 |
| test-trending.ts | main | 52 |
| transcript.ts | getTranscript | 22 |
| youtube.ts | getPlaylistVideos | 21 |
| youtube.ts | getTopComments | 22 |
| youtube.ts | itemToMeta | 19 |
| youtube.ts | searchItemToMeta | 19 |

---

## Phase 3 — Frontend (Design Notes)

**Goal:** Manage channels/topics and browse summaries without editing config files. Email is already working — this phase adds a web UI on top of the existing backend.

**Stack — likely: Next.js**
- Full-stack TypeScript. API routes + React in one repo.
- Same language as the backend — natural monorepo path.
- Alternative: SvelteKit (lighter) if simplicity matters more than ecosystem.

**UI features to build:**
- **Auth** — sign in / sign up (email + Google OAuth). Multi-user from day one — each user has their own channels, topics, and preferences
- **Channel manager** — add/remove channels by URL or ID, toggle enabled/disabled
- **Topic/keyword manager** — manage search queries that run alongside channels
- **Summary browser** — paginated, filterable list of past summaries with expand + video link
- **Settings panel** — videos per run, email address, send time, on/off toggle
- **Watch history** — mark videos as watched or interesting; feed into future prioritization
- **Category preference picker** — 1–5 interest sliders for YouTube's 15 content categories (taxonomy sourced from `topic_labels` table)
- **Music preference manager** — genre picker (from accumulated `topic_labels`), sub-genre multi-select, artist list
- **Algorithm score review** — view both Claude verdict and integer score side-by-side per video, flag disagreements to feed back into scoring calibration
- **Semantic search** — "find summaries about X" powered by pgvector embeddings on the `videos` table

**API layer:** Next.js API routes reading from Supabase Postgres via Drizzle ORM. Auth via Supabase Auth + `@supabase/ssr` middleware.

**New frontend dependencies:**
```bash
npm install @supabase/supabase-js @supabase/ssr
```

**Auth flow:** Supabase handles sign-up/sign-in. `middleware.ts` runs on every request, validates the JWT, and refreshes it if expired. Protected routes redirect unauthenticated users to `/login`. Server Components use `createServerClient`; Client Components use `createBrowserClient`. Never call `getSession()` server-side — use `getUser()`.

**Email link update (Phase 3):** Video title links in the email currently point to YouTube. Once the frontend exists, these should point to the Tube Chew summary page for that video. Placeholder noted in `mailer.ts`.
