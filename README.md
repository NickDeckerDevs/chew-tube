<!--
5/22/2026 - nick decker | phase 2 doc catch-up
ADDED
- "Running the Digest" section with `npm run digest`, `npm run test-email`, `npm run backfill`, `npm run fix-titles`
- `RESEND_API_KEY` and `DIGEST_TO_EMAIL` to the env setup section
- `What It Does` bullet for email digest delivery via Resend

CHANGED
- Phase 2 marked ✅ COMPLETE in Roadmap (was shown as future)
- Phase 3 description updated to reflect email is done; only frontend remains

5/22/2026 - nick decker | phase 1 task work
ADDED
- Channel List section with categorized channels, @handles, and resolved IDs
- `playlist` command for fetching videos from a playlist by ID or full URL
- `categories` command to list all assignable YouTube trending categories
- `resolve` command to look up a channel ID from a @handle

CHANGED
- `channel` command now accepts @handle in addition to channel IDs
- Expanded category table with full list of IDs
- Updated DB path reference from `backend/data/` to `data/`
- Updated "The Person Behind the Digestion" blurb
- Fixed all Channel List command examples to include full `npx tsx src/index.ts` prefix
-->

# 🍽️ Tube Chew

> *Because life's too short to watch every video, but too long to miss the good ones.*

Tube Chew is a personal YouTube digest engine. It chews through videos so you don't have to — fetching transcripts, extracting the good stuff, and giving you a clean daily dump of what actually matters. Think of it as a digestive system for your YouTube feed: everything goes in, only the nutrients come out.

No more sitting through 45-minute videos to extract three useful sentences. Tube Chew does the heavy lifting, so you get the key takeaways without the bloat.

---

## 📋 Table of Contents

- [What It Does](#-what-it-does)
- [Roadmap](#-roadmap)
- [Installation](#-installation)
- [Running the Digest](#-running-the-digest)
- [Usage](#-usage)
- [Channel List](#-channel-list)
- [The Person Behind the Digestion](#-the-person-behind-the-digestion)

---

## 💩 What It Does

**Right now, Tube Chew can:**

- **Fetch YouTube videos** five ways:
  - Trending videos (optionally filtered by category — Science & Tech, Entertainment, etc.)
  - Latest uploads from a specific channel (by channel ID or `@handle`)
  - Videos from any playlist (by ID or full URL)
  - Keyword/topic search
  - Browse available categories or resolve a `@handle` to its channel ID
- **Pull transcripts** directly from YouTube — no scraping, no downloading, no Puppeteer nonsense. If a video has captions (including auto-generated), we've got it.
- **Handle long-form content** — estimates transcript length and automatically uses a map-reduce approach for anything too large to summarize in one shot (think 3-hour conference talks).
- **Summarize with Claude Haiku** — each video gets:
  - A one-sentence summary
  - 3–5 key takeaways
  - A worth-watching verdict with a reason
- **Store everything locally** in SQLite — idempotent, so re-running never double-processes a video.
- **Pretty CLI output** — color-coded results printed right in your terminal.
- **Email digest delivery** — sends a daily HTML digest via Resend. Each video gets a thumbnail, short summary, verdict, one-liner, and key takeaways. Runs automatically via GitHub Actions at 7am CT.

It works both as a CLI tool and as a daily automated digest. Run it manually, or let GitHub Actions chew for you every morning.

---

## 🗺️ Roadmap

The long-term vision is a full pipeline — from raw YouTube feed to inbox-ready daily digest.

**Phase 2 — Personalization & Automation ✅ COMPLETE**
- `config.json` for managing your own channel list and topic keywords
- Scheduled daily runs via GitHub Actions cron (7am CT)
- HTML email digest via Resend — thumbnail, short summary, verdict, one-liner, and key takeaways per video
- Automated runs idempotent — re-running never re-processes already-summarized videos

**Phase 3 — Frontend (next)**
- Web UI to manage channels, topics, and preferences
- Browse and search past summaries
- Mark videos as watched or interesting (feeds future prioritization)
- Full settings panel (email, send time, video count, etc.)
- Video title links in email will point to the frontend summary page once it exists

---

## 🔧 Installation

### Prerequisites

- **Node.js** v18 or higher
- A **YouTube Data API v3 key** (free)
  1. Go to [Google Cloud Console](https://console.cloud.google.com)
  2. Create a project → APIs & Services → Enable **YouTube Data API v3**
  3. Credentials → Create API Key
- An **Anthropic API key** — [get one here](https://console.anthropic.com)
- A **Resend API key** — [sign up at resend.com](https://resend.com) (3,000 free emails/month)

### Setup

```bash
# Clone the repo
git clone <your-repo-url>
cd tube-chew/backend

# Install dependencies
npm install

# Set up your environment
cp .env.example .env
```

Open `backend/.env` and fill in your keys:

```
YOUTUBE_API_KEY=your_youtube_key_here
ANTHROPIC_API_KEY=your_anthropic_key_here
RESEND_API_KEY=your_resend_key_here
DIGEST_TO_EMAIL=you@example.com
```

---

## 📬 Running the Digest

Run from the `backend/` directory:

```bash
# Run the full daily digest (reads config.json, 24h cutoff, sends email)
npm run digest

# Send a test email with 5 random videos from the DB
npm run test-email

# Backfill thumbnail_url + short_summary for existing DB rows
npm run backfill

# Fix HTML entities in stored title/channel fields
npm run fix-titles
```

The digest reads `config.json` at the project root, pulls videos from configured channels and topics published in the last 24 hours, summarizes any new ones, and emails the results to `DIGEST_TO_EMAIL`.

**GitHub Actions** runs `npm run digest` automatically at 7am CT daily. Set these secrets in your repo (Settings → Secrets and variables → Actions):

| Secret | Value |
|--------|-------|
| `YOUTUBE_API_KEY` | from Google Cloud Console |
| `ANTHROPIC_API_KEY` | from Anthropic Console |
| `RESEND_API_KEY` | from Resend dashboard |
| `DIGEST_TO_EMAIL` | your email address |

Manual runs are available from the Actions tab via `workflow_dispatch`.

---

## 🚽 Usage

Run from the `backend/` directory:

```bash
# Trending videos (top 5, US)
npx tsx src/index.ts trending

# Trending in Science & Tech (category 28)
npx tsx src/index.ts trending --category 28

# Latest from a specific channel (by ID or @handle)
npx tsx src/index.ts channel UCFbNIlppjAuEX4znoulh0Cw
npx tsx src/index.ts channel @WebDevSimplified

# Keyword search
npx tsx src/index.ts search "AI agents"

# Videos from a playlist (ID or full URL)
npx tsx src/index.ts playlist PLf2m23nhTg1P5BsOHUOXyQz5RhfUSSVUi
npx tsx src/index.ts playlist "https://www.youtube.com/watch?v=oDks2gVHu4k&list=PLf2m23nhTg1P5BsOHUOXyQz5RhfUSSVUi"

# List all available trending categories
npx tsx src/index.ts categories

# Look up a channel ID from its @handle
npx tsx src/index.ts resolve @WebDevSimplified

# Fetch more videos at once
npx tsx src/index.ts trending --n 10
```

### Finding Channel IDs

YouTube URLs show handles (`@channelname`), not IDs. Use the `resolve` command to get the `UC...` ID:

```bash
npx tsx src/index.ts resolve @NetworkChuck
# NetworkChuck  →  UC9x0AN7BWHpCDHSm9NiJFJQ
# npx tsx src/index.ts channel UC9x0AN7BWHpCDHSm9NiJFJQ
```

Or pass the `@handle` directly to the `channel` command — it auto-resolves:

```bash
npx tsx src/index.ts channel @NetworkChuck
```

### Category IDs

Run `npx tsx src/index.ts categories` to get the live list from the API. Common ones:

| ID | Category | ID | Category |
|----|----------|----|----------|
| 1  | Film & Animation | 22 | People & Blogs |
| 2  | Autos & Vehicles | 23 | Comedy |
| 10 | Music | 24 | Entertainment |
| 15 | Pets & Animals | 25 | News & Politics |
| 17 | Sports | 26 | Howto & Style |
| 19 | Travel & Events | 27 | Education |
| 20 | Gaming | **28** | **Science & Technology** |
| 21 | Videoblogging | 29 | Nonprofits & Activism |

### Example Output

```
Fetched 5 video(s). Processing...

Transcribing: How I Built an AI Agent in 20 Minutes...  ✓ (3,241 tokens)
Summarizing...  ✓

How I Built an AI Agent in 20 Minutes
fireship · https://youtube.com/watch?v=xxxxxxx

A hands-on walkthrough of building a minimal AI agent using the Anthropic SDK
and tool use in under 20 minutes.

Key takeaways:
  • Tool use is the core primitive — agents are just LLMs that can call functions
  • Keep the agent loop simple: call model → check for tool use → execute → repeat
  • Error handling matters more than capabilities in real-world agents
  • The SDK handles most of the boilerplate; you just define tools as JSON schemas

✓ Worth watching — Dense, practical, and short enough to watch in one sitting.
────────────────────────────────────────────────────
```

### Verify It Worked

```bash
# Check the database directly
sqlite3 data/summaries.db "SELECT id, title, one_liner FROM videos;"
```

Re-running the same command will skip already-processed videos — no duplicate digestion.

---

## 📺 Channel List

> All commands run from `backend/`. `--n <count>` is optional (default: 5).
> IDs were resolved via `npx tsx src/index.ts resolve @handle`. Run that command to verify or look up new channels.

### Coding / Development

| Channel | @Handle | Channel ID | Command |
|---------|---------|-----------|---------|
| Anthropic | @anthropic-ai | `UCrDwWp7EBBv4NwvScIpBDOA` | `npx tsx src/index.ts channel UCrDwWp7EBBv4NwvScIpBDOA` |
| Indie Dev Dan | @indydevdan | `UC_x36zCEGilGpB1m-V4gmjg` | `npx tsx src/index.ts channel UC_x36zCEGilGpB1m-V4gmjg` |
| Web Dev Simplified | @WebDevSimplified | `UCFbNIlppjAuEX4znoulh0Cw` | `npx tsx src/index.ts channel UCFbNIlppjAuEX4znoulh0Cw` |
| NetworkChuck | @NetworkChuck | `UC9x0AN7BWHpCDHSm9NiJFJQ` | `npx tsx src/index.ts channel UC9x0AN7BWHpCDHSm9NiJFJQ` |

### Tech, Surveillance & Society

| Channel | @Handle | Channel ID | Command |
|---------|---------|-----------|---------|
| Benn Jordan | @BennJordan | `UCshObcm-nLhbu8MY50EZ5Ng` | `npx tsx src/index.ts channel UCshObcm-nLhbu8MY50EZ5Ng` |
| Digital Trends | @digitaltrends | `UC8wXC0ZCfGt3HaVLy_fdTQw` | `npx tsx src/index.ts channel UC8wXC0ZCfGt3HaVLy_fdTQw` |
| Louis Rossmann | @rossmanngroup | `UCl2mFZoRqjw_ELax4Yisf6w` | `npx tsx src/index.ts channel UCl2mFZoRqjw_ELax4Yisf6w` |
| Ryan McBeth | @RyanMcBethProgramming | `UC8URMa1fI4rlaLc-Lhev2fQ` | `npx tsx src/index.ts channel UC8URMa1fI4rlaLc-Lhev2fQ` |

### Cooking / Recipes

| Channel | @Handle | Channel ID | Command |
|---------|---------|-----------|---------|
| That Dude Can Cook | @thatdudecancook | `UC19OYOBqkgVqgTIQxbsPdlw` | `npx tsx src/index.ts channel UC19OYOBqkgVqgTIQxbsPdlw` |
| Brad Leone | @bradleone | `UC1NFFogiT88Uhmidrz8Ypnw` | `npx tsx src/index.ts channel UC1NFFogiT88Uhmidrz8Ypnw` |
| J. Kenji López-Alt | @JKenjiLopezAlt | `UCqqJQ_cXSat0KIAVfIfKkVA` | `npx tsx src/index.ts channel UCqqJQ_cXSat0KIAVfIfKkVA` |
| Joshua Weissman | @JoshuaWeissman | `UChBEbMKI1eCcejTtmI32UEw` | `npx tsx src/index.ts channel UChBEbMKI1eCcejTtmI32UEw` |
| Joshua Weissman Recipes | @JoshuaWeissmanRecipes | `UCUAg71CJEvFdOnujmep1Svw` | `npx tsx src/index.ts channel UCUAg71CJEvFdOnujmep1Svw` |

### Funny Stuff

| Channel | @Handle | Channel ID | Command |
|---------|---------|-----------|---------|
| MagicTheNoah | @MagicTheNoah | `UCYqsJbDDngvxb_rbHzHpYGA` | `npx tsx src/index.ts channel UCYqsJbDDngvxb_rbHzHpYGA` |
| Gianmarco Soresi | @GianmarcoSoresi | `UCCYWagpWEequTwx61dYGT0w` | `npx tsx src/index.ts channel UCCYWagpWEequTwx61dYGT0w` |
| Taskmaster | @Taskmaster | `UCT5C7yaO3RVuOgwP8JVAujQ` | `npx tsx src/index.ts channel UCT5C7yaO3RVuOgwP8JVAujQ` |

### Soccer Coaching

| Channel | @Handle | Channel ID | Command |
|---------|---------|-----------|---------|
| Coach Rory Soccer | @CoachRorySoccer | `UCxjqkVEAAQfWN2iW1oEaXTw` | `npx tsx src/index.ts channel UCxjqkVEAAQfWN2iW1oEaXTw` |

### Pokémon GO

| Channel | @Handle | Channel ID | Command |
|---------|---------|-----------|---------|
| DanOttawa | @DanOttawa | `UCqoEBvsSaKWhw8KbPPWOLEg` | `npx tsx src/index.ts channel UCqoEBvsSaKWhw8KbPPWOLEg` |

### Minecraft

| Channel | @Handle | Channel ID | Command |
|---------|---------|-----------|---------|
| BDoubleO | @bdoubleo | `UClu2e7S8atp6tG2galK9hgg` | `npx tsx src/index.ts channel UClu2e7S8atp6tG2galK9hgg` |
| EthosLab | @EthosLab | `UCFKDEp9si4RmHFWJW1vYsMA` | `npx tsx src/index.ts channel UCFKDEp9si4RmHFWJW1vYsMA` |
| wattlesplays | @wattlesplays | `UCsuKgiVb2KJ2sZdrrwoAqsA` | `npx tsx src/index.ts channel UCsuKgiVb2KJ2sZdrrwoAqsA` |
| xisumavoid | @xisumavoid | `UCU9pX8hKcrx06XfOB-VQLdw` | `npx tsx src/index.ts channel UCU9pX8hKcrx06XfOB-VQLdw` |
| Hermitcraft Recap | @TheHermitcraftRecap | `UC32w6uX5qtmUtF4QQQ2PKaQ` | `npx tsx src/index.ts channel UC32w6uX5qtmUtF4QQQ2PKaQ` |

### FC 26 / Football Games

| Channel | @Handle | Channel ID | Command |
|---------|---------|-----------|---------|
| NaNNiK Gaming | @NaNNiKGaming | `UCw0iQFZw-sVk92WQOmq4Kkw` | `npx tsx src/index.ts channel UCw0iQFZw-sVk92WQOmq4Kkw` |
| ProRecoil | @officialprorecoil | *(run `resolve @officialprorecoil`)* | `npx tsx src/index.ts resolve @officialprorecoil` |

### Society & Political Commentary

| Channel | @Handle | Channel ID | Command |
|---------|---------|-----------|---------|
| The Majority Report | @TheMajorityReport | `UC-3jIAlnQmbbVMV6gR7K8aQ` | `npx tsx src/index.ts channel UC-3jIAlnQmbbVMV6gR7K8aQ` |
| Last Week Tonight | @LastWeekTonight | `UC3XTzVzaHQEd30rQbuvCtTQ` | `npx tsx src/index.ts channel UC3XTzVzaHQEd30rQbuvCtTQ` |

### A Category of His Own

| Channel | @Handle | Channel ID | Command |
|---------|---------|-----------|---------|
| Mark Rober | @MarkRober | `UCY1kMZp36IQSyNx_9h4mpCg` | `npx tsx src/index.ts channel UCY1kMZp36IQSyNx_9h4mpCg` |

### Self Promotion (but not worth doing)

| Channel | @Handle | Channel ID | Command |
|---------|---------|-----------|---------|
| imsotrash239 | @imsotrash239 | `UCYoICL--E3Gk7lBB0aZVgLA` | `npx tsx src/index.ts channel UCYoICL--E3Gk7lBB0aZVgLA` |

---

## 🎥 The Person Behind the Digestion

Built by [@imsotrash239](https://www.youtube.com/@imsotrash239) — go subscribe if you want to see the kind of content this thing eventually summarizes -- and to be fair my content is as trash as this repo. Fair warning: the irony of using an AI digest tool on your own channel has not been lost on me.
