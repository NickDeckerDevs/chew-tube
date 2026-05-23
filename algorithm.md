# Algorithm

Living design document. Covers what is currently implemented, what is planned, and open design questions.

---

## Philosophy

The goal is not to summarize every video — it is to surface the small fraction that's genuinely worth the viewer's time. A 65% skip rate is not a failure; it's the algorithm doing its job. Trust comes from consistent precision, not high recall. Users will tolerate missed videos far longer than they'll tolerate noise.

---

## Top Algorithm TODOs

1. **Music genre scoring path** — `musicPreferences` config, genre/artist detection from `topicDetails`, own scoring logic separate from the transcript-based verdict. See Planned — Music & Genre Handling.

2. **Negative scoring signals (second -10)** — intentionally deferred until parallel scoring is running and real disagreements surface from email review. Will be designed from observed cases, not up front.

---

Two scores run in parallel (see Planned — Integer Scoring):
- **Claude verdict** — qualitative 3-tier label from a language model with full context
- **Integer score** — transparent, auditable points breakdown for calibration

The integer score does not replace the verdict. It makes the algorithm's reasoning visible so thresholds can be tuned empirically.

---

## Current Implementation

### 3-Tier Verdict (live)

Claude returns one of three labels via `tool_use` in `summarizer.ts`:

| Verdict | Meaning |
|---------|---------|
| `watch` | Content clearly matches persona and delivers on its title |
| `conditional` | Has value for some viewers — verdict_detail specifies "Watch if X, skip if Y" |
| `skip` | Clickbait, excessive filler, or irrelevant to persona |

`worth_watching` (boolean) is preserved for backwards compatibility: `watch` and `conditional` both map to `true`.

### Signals Fed to Claude (live)

| Signal | How it's used |
|--------|--------------|
| Stated persona string | Injected into system prompt: "developer soccer dad with a 9 year old that loves video games, cook, music festivals" |
| Channel-derived persona | Per-channel summaries + thematic category groupings from `build-persona.ts`, injected into system prompt |
| Source type | Channel-sourced videos get a higher bar — "existing interest in this creator" bias toward watch; topic/search sources get neutral treatment |
| Per-channel profile | If the video comes from a configured channel, that channel's specific summary is injected alongside the general profile |
| Transcript | Full text (or chunked summaries for long videos) |
| Video title | Evaluated against transcript for clickbait detection |

### Clickbait Detection (live)

Claude returns `clickbait: boolean` + `clickbait_reason: string`. A title is clickbait if it makes a promise the transcript does not meaningfully deliver on. Sensationalized-but-accurate titles are not flagged.

### Shorts Filtering (live — digest only)

`getVideoDurations()` batch-fetches `contentDetails` for fetched videos. `isShort()` filters anything under 62 seconds before transcription. Currently implemented in `digest.ts` only — not yet in `queue-fill.ts`.

### Top Comments (live)

After summarization, top 2 comments by relevance are fetched via `commentThreads.list` and stored as `top_comments` JSON. Included in digest email.

### Rate Limit Handling (live)

`callSummaryTool` in `summarizer.ts` catches 429 responses and retries up to 3 times with exponential backoff (60s × attempt). The queue worker adds a 15-second fixed delay between Claude calls (~40k tokens/min, safely under the 50k/min limit).

### Category Preferences (stored — not yet used in scoring)

`config.json` has `categoryPreferences` — a 1-5 interest score for each of the 15 YouTube content categories. Currently stored but not passed to Claude or used in scoring. Autos is 1★ but car restoration videos are still scoring `watch` — this is the clearest symptom that this signal needs to reach the verdict.

```json
"categoryPreferences": {
  "1":  2,   // Film & Animation
  "2":  1,   // Autos & Vehicles
  "10": 4,   // Music
  "15": 2,   // Pets & Animals
  "17": 4,   // Sports
  "19": 3,   // Travel & Events
  "20": 5,   // Gaming
  "22": 2,   // People & Blogs
  "23": 3,   // Comedy
  "24": 3,   // Entertainment
  "25": 4,   // News & Politics
  "26": 4,   // Howto & Style
  "27": 3,   // Education
  "28": 5,   // Science & Technology
  "29": 1    // Nonprofits & Activism
}
```

---

## Data Model — Signals Captured Per Video

### Currently stored

| Field | Type | Notes |
|-------|------|-------|
| `id` | TEXT | YouTube video ID |
| `title` | TEXT | |
| `channel` | TEXT | Channel display name |
| `published_at` | TEXT | ISO 8601 |
| `description` | TEXT | YouTube description snippet |
| `thumbnail_url` | TEXT | Medium (320×180) |
| `one_liner` | TEXT | Single-sentence Claude summary |
| `short_summary` | TEXT | 2-3 sentence email preview |
| `takeaways` | TEXT | JSON array of 3-5 bullet points |
| `worth_watching` | INTEGER | Boolean, backwards compat |
| `worth_watching_reason` | TEXT | |
| `verdict` | TEXT | "watch" \| "conditional" \| "skip" |
| `verdict_detail` | TEXT | Nuanced reason / "watch if X, skip if Y" |
| `clickbait` | INTEGER | Boolean |
| `clickbait_reason` | TEXT | |
| `top_comments` | TEXT | JSON array of `{author, text, likes}` |
| `summarized_at` | TEXT | |

### Needs to be added

| Field | Type | Why |
|-------|------|-----|
| `category_id` | TEXT | YouTube category — needed for preference modifier |
| `topic_categories` | TEXT | JSON array from `topicDetails.topicCategories` — genre labels for music and other categories ("Electronic music", "Hip hop music", etc.) |
| `score` | INTEGER | Computed integer score (see Planned — Integer Scoring) |
| `score_breakdown` | TEXT | JSON: `{baseline, statedPersona, channelPersona, categoryModifier, negatives, total}` |

---

## Sources

### Digest (daily, live)

- **28 configured channels** — uploads playlist, 20 videos each, 24-hour publish cutoff
- **3 topic keyword searches** — 3 videos each

### Algo-Test (on-demand, live)

24 sources across three groups:

| Group | Sources |
|-------|---------|
| Trending — All | 1 US overall trending |
| Trending — by category | 13 of the 15 categories (Education and Travel & Events 404 on `chart=mostPopular`) |
| Keyword searches | AI coding tools, Soccer training, Quick dinner recipes, Indie game reviews, Music festivals, Knitting tutorials, Car restoration, News commentary |

Each source has an `interestScore` (1-5) drawn from `categoryPreferences` or set manually for keyword searches.

---

## Persona System

### Stated Persona (`config.settings.persona`)

Free-text string describing the viewer. Injected directly into the Claude system prompt.

> "developer soccer dad with a 9 year old that loves to play video games, cook, and go to music festivals"

### Channel-Derived Persona (`build-persona.ts` → `persona-profile.json`)

Run `npm run build-persona` whenever channels change. Fetches the top 5 recent videos from each configured channel and sends them all to Claude in one call to produce:

- **Per-channel summary** — what the channel covers and what following it reveals about the viewer
- **Thematic category groupings** — channels that share a theme, grouped by Claude (e.g., "cooking channels", "Minecraft / survival games")
- **Per-category synthesis** — a richer interest signal from multiple channels in the same space

Both are injected into the Claude system prompt for every verdict call.

---

## Planned — Integer Scoring

### Design Goal

Run a transparent, auditable point score alongside the Claude verdict. Show both in emails and store both in the DB. Use the comparison to calibrate thresholds over time before promoting the integer score to primary.

### Score Components

```
BASELINE (source type)
  Channel video ........... +5   (viewer already opted into this creator)
  Trending / search ....... +0

POSITIVE — Stated persona match
  Strong match ............ +10
  Partial match ........... +5

POSITIVE — Channel-derived persona match
  3+ categories matched ... +10
  2 categories matched .... +6
  1 category matched ...... +3

CATEGORY PREFERENCE MODIFIER
  Acts as a multiplier on persona match points (1-5 scale)
  Exact formula TBD — under review

NEGATIVE (max total: -20)
  Clickbait detected ...... -10
  [other signals TBD] ..... up to -10 more

POSSIBLE RANGE
  Maximum positive: 5 (channel) + 10 (stated) + 10 (channel-derived) = 25
  Maximum negative: -20
```

### Watch / Conditional / Skip Thresholds

TBD. Under review. Will be determined after first scored dataset is compared against Claude verdict.

### What's Still Open

1. **Remaining negative signals** — clickbait accounts for -10. The additional -10 is intentionally deferred. The design here is to observe real scored output in the email, note disagreements, and work those cases into the negative signal definition. This will emerge from use, not be designed up front.

2. **Category preference multiplier formula** — does the 1-5 score linearly scale persona points (1★ = ×0.2, 5★ = ×1.0), or is it a tiered modifier? Under review.

3. **Thresholds** — what integer score maps to watch vs conditional vs skip? To be defined after first parallel run.

---

## Planned — Music & Genre Handling

**Status: designed, not yet built. One of the two top algorithm TODOs.**

### Problem

Music videos have no useful transcript. Auto-captions on music = lyrics, not information. The current algo-test shows ~5% watch rate on Music category trending and ~30% on Music Festivals — both are burning quota on content that Claude can't meaningfully evaluate from transcript alone.

### Music gets its own scoring path

Music-related videos (YouTube category 10, or `topicCategories` containing a music genre) will be scored differently from all other video types. The existing persona-match / transcript-based verdict does not apply.

Instead, scoring is driven by genre and artist preference signals — no Claude verdict call needed for music.

### New config: `musicPreferences` JSON

A new top-level key in `config.json` (separate from `categoryPreferences`). Live in config as of 2026-05-23.

```json
"musicPreferences": {
  "genres": [
    "Electronic music",
    "Hip hop music",
    "Soul music",
    "Independent music"
  ],
  "subGenres": [
    "Electro-Soul", "Glitch-Hop", "Trip-Hop", "Future Funk",
    "Indietronica", "Future Bass", "Downtempo", "Chillwave",
    "World Bass", "Tribal Bass", "Neo-Trip-Hop", "Trap"
  ],
  "artists": [
    "Artifakts", "Clozee", "Pretty Lights", "RL Grime"
  ]
}
```

**Field meanings:**
- `genres` — YouTube `topicDetails.topicCategories` labels (official taxonomy, matched against what YouTube returns). Full YouTube music genre list: Christian music, Classical music, Country, Electronic music, Hip hop music, Independent music, Jazz, Music of Asia, Music of Latin America, Pop music, Rhythm and blues, Rock music, Soul music.
- `subGenres` — user-defined fine-grained preferences. Used by the LLM for thematic similarity matching ("this artist shares DNA with Downtempo and Trip-Hop"). Not matched against any API field — pure LLM reasoning.
- `artists` — known favorite artists. LLM finds thematic similarity between incoming artist and these references ("shares Pretty Lights' approach of sampling vintage soul over electronic production").

**Phase 3 note:** Genre and sub-genre selection will get a UI. The full YouTube genre taxonomy is 13 labels (listed above) and sub-genres can be sourced from established genre taxonomies (Discogs, AllMusic, etc.) for a picker.

### Available Signals (from YouTube API)

| Signal | Reliability | Notes |
|--------|-------------|-------|
| `topicDetails.topicCategories` | **Excellent** | Wikipedia-linked genre labels. Works even for fan uploads with no tags. Returns "Electronic music", "Hip hop music", "Pop music", etc. |
| `snippet.tags` | **Variable** | VEVO/official channels: rich tags (artist, genre, label). Fan live-set uploads: often empty. |
| Title pattern | **Good** | "Artist - Song Title" and "Artist \| Live @ Venue" both parseable. |
| Channel name | **Good for official, useless for fans** | DrakeVEVO → Drake. "hammyt88" → nothing. |

### User's Taste — Electronic Music Live Sets

The user's five test videos are all long-form electronic music live sets (58 min – 3.5 hours):
- Artifakts, Clozee, Pretty Lights, RL Grime
- `topicCategories`: "Electronic music" on all five
- Nothing from trending Music category matches this taste

### Still to design

- Exact integer score values for genre match, artist match, format match
- Whether a genre match without transcript defaults to `conditional` or goes straight to `watch`
- How `musicPreferences` is populated — manual config only, or assisted by a build step similar to `build-persona`

---

## Baseline Test Results (2026-05-23)

Two runs against 24 algo-test sources:

**Algo-test run** — 886 videos processed
| Verdict | Count | Rate |
|---------|-------|------|
| Watch | 266 | 30% |
| Conditional | 43 | 5% |
| Skip | 577 | 65% |

**Queue-work run** — 465 videos processed (non-overlapping, keyword-search-heavy sample)
| Verdict | Count | Rate |
|---------|-------|------|
| Watch | 206 | 44% |
| Conditional | 24 | 5% |
| Skip | 235 | 51% |

### Per-Source Patterns

| Source | Watch Rate | Notes |
|--------|-----------|-------|
| AI coding tools | ~90% | Best-performing source |
| Indie game reviews | ~95% | Strongest by far |
| Quick dinner recipes | ~85% | Very high signal |
| Soccer training | ~55% | Good but noisier |
| Music festivals | ~30% | Better than music trending — content is evaluable |
| Trending: Sci/Tech | ~50% | Shorts inflate skip rate |
| Trending: News | ~40% | Hot-take clickbait correctly skipped |
| Car restoration | ~35% | Autos rated 1★ — still passing at 35%. Category signal needed. |
| Trending: Sports | ~10% | Mostly Shorts + highlight clips |
| Knitting tutorials | ~2% | Correctly rejected; still burning quota |
| Trending: Music | ~5% | Transcript = lyrics. Not useful. |

### Key Takeaways

- Keyword searches are the highest-signal source by a wide margin
- Category trending is noisy — useful mainly for discovery calibration
- Category preferences not yet used → low-interest categories (Autos, Knitting) still burning quota and occasionally passing
- Music trending is unscoreable via transcript — needs genre-based path

---

## Architecture Notes

### Queue Pipeline

```
queue-fill.ts  → fetches videos, gets transcripts, inserts into queue (no Claude calls)
queue-work.ts  → dequeues one at a time, calls Claude, saves to videos table
                 15-second fixed delay between calls (~40k tokens/min, under 50k limit)
```

Atomic dequeue uses SQLite transaction (SELECT + UPDATE to 'processing') — crash-safe. Worker resets stuck 'processing' items on startup.

### Quota Usage

| Operation | Cost | Notes |
|-----------|------|-------|
| `playlistItems.list` | 1 unit/call | Channel video fetching |
| `videos.list` (durations) | 1 unit per 50 IDs | Shorts filtering |
| `videos.list` (signals) | 1 unit per 50 IDs | Category, genre, tags |
| `search.list` | 100 units/call | Topic searches only |
| `commentThreads.list` | ~1 unit/call | Top comments per video |
| `channels.list` | 1 unit/call | Resolving uploads playlist IDs |

### Category API Gaps

`chart=mostPopular` does not support all YouTube category IDs. Known failures:
- Category 27 (Education) — 404
- Category 19 (Travel & Events) — 404

These are skipped in algo-test with a try/catch and logged.
