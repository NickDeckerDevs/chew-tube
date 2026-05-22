# 🍽️ Tube Chew

> *Because life's too short to watch every video, but too long to miss the good ones.*

Tube Chew is a personal YouTube digest engine. It chews through videos so you don't have to — fetching transcripts, extracting the good stuff, and giving you a clean daily dump of what actually matters. Think of it as a digestive system for your YouTube feed: everything goes in, only the nutrients come out.

No more sitting through 45-minute videos to extract three useful sentences. Tube Chew does the heavy lifting, so you get the key takeaways without the bloat.

---

## 📋 Table of Contents

- [What It Does](#-what-it-does)
- [Roadmap](#-roadmap)
- [Installation](#-installation)
- [Usage](#-usage)
- [The Person Behind the Digestion](#-the-person-behind-the-digestion)

---

## 💩 What It Does

**Right now, Tube Chew can:**

- **Fetch YouTube videos** three ways:
  - Trending videos (optionally filtered by category — Science & Tech, Entertainment, etc.)
  - Latest uploads from a specific channel
  - Keyword/topic search
- **Pull transcripts** directly from YouTube — no scraping, no downloading, no Puppeteer nonsense. If a video has captions (including auto-generated), we've got it.
- **Handle long-form content** — estimates transcript length and automatically uses a map-reduce approach for anything too large to summarize in one shot (think 3-hour conference talks).
- **Summarize with Claude Haiku** — each video gets:
  - A one-sentence summary
  - 3–5 key takeaways
  - A worth-watching verdict with a reason
- **Store everything locally** in SQLite — idempotent, so re-running never double-processes a video.
- **Pretty CLI output** — color-coded results printed right in your terminal.

It's a CLI tool for now. You run it, it processes, you read. No frills, no UI, just fiber-rich content right to the terminal.

---

## 🗺️ Roadmap

The long-term vision is a full pipeline — from raw YouTube feed to inbox-ready daily digest.

**Phase 2 — Personalization & Automation**
- Config file for managing your own channel list and topic keywords
- Scheduled daily runs (cron / cloud scheduler)
- HTML email digest via Resend — one section per video, delivered to your inbox every morning

**Phase 3 — Frontend**
- Web UI to manage channels, topics, and preferences
- Browse and search past summaries
- Mark videos as watched or interesting (feeds future prioritization)
- Full settings panel (email, send time, video count, etc.)

---

## 🔧 Installation

### Prerequisites

- **Node.js** v18 or higher
- A **YouTube Data API v3 key** (free)
  1. Go to [Google Cloud Console](https://console.cloud.google.com)
  2. Create a project → APIs & Services → Enable **YouTube Data API v3**
  3. Credentials → Create API Key
- An **Anthropic API key** — [get one here](https://console.anthropic.com)

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
```

---

## 🚽 Usage

Run from the `backend/` directory:

```bash
# Trending videos (top 5, US)
npx tsx src/index.ts trending

# Trending in Science & Tech (category 28)
npx tsx src/index.ts trending --category 28

# Latest from a specific channel
npx tsx src/index.ts channel UCxxxxxxxxxxxxxxxx

# Keyword search
npx tsx src/index.ts search "AI agents"

# Fetch more videos at once
npx tsx src/index.ts trending --n 10
```

**Category IDs for trending:**
| ID | Category |
|----|----------|
| 28 | Science & Technology |
| 22 | People & Blogs |
| 24 | Entertainment |
| 26 | Howto & Style |

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
sqlite3 backend/data/summaries.db "SELECT id, title, one_liner FROM videos;"
```

Re-running the same command will skip already-processed videos — no duplicate digestion.

---

## 🎥 The Person Behind the Digestion

Built by [@imsotrash239](https://www.youtube.com/@imsotrash239) — go subscribe if you want to see the kind of content this thing eventually summarizes. Fair warning: the irony of using an AI digest tool on your own channel has not been lost on us.
