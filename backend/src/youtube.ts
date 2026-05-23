/*
5/23/2026 - nick decker | topic label catalogue
CHANGED
- `getVideoSignals()` calls `upsertTopicLabels` after building the out map, passing each decoded label with its source Wikipedia URL
- `getTrending()` calls `upsertTopicLabels` after mapping items, same pattern

5/23/2026 - nick decker | category signals
ADDED
- `getVideoSignals(ids)` — batch-fetches snippet + topicDetails for up to 50 video IDs; returns map of id → { categoryId, topicCategories }; topicCategories decoded from Wikipedia URLs (split on /wiki/, decode URI component, replace underscores with spaces)
- `getVideoSignals` exported for use by digest.ts, queue-fill.ts, algo-test.ts

CHANGED
- `getTrending()` now requests `topicDetails` in addition to `snippet`; maps `categoryId` from `snippet.categoryId` and `topicCategories` from `topicDetails` onto returned `VideoMeta` items

5/23/2026 - nick decker | shorts filtering
ADDED
- `getVideoDurations(ids)` — batch-fetches contentDetails for up to 50 video IDs (1 quota unit); returns map of id → duration seconds
- `isShort(durationSeconds)` — returns true for videos under 62 seconds (Shorts threshold)

5/22/2026 - nick decker | persona profile builder
ADDED
- `getUploadsPlaylistId(channelId)` — fetches a channel's uploads playlist ID via channels.list (1 quota unit vs 100 for search.list); used by build-persona to avoid blowing search quota

5/22/2026 - nick decker | verdict algorithm v2
ADDED
- `getTopComments(videoId, n)` — fetches top n comments by like count via YouTube commentThreads.list API

5/22/2026 - nick decker | phase 1 task work
ADDED
- `getCategories(regionCode)` — fetches assignable YouTube video categories sorted by ID
- `resolveHandle(handle)` — resolves a @handle to its channel ID via the YouTube API
- `extractPlaylistId(input)` — parses a playlist ID out of a full YouTube URL or returns input as-is
- `getPlaylistVideos(playlistId, n)` — fetches up to n videos from a playlist

5/22/2026 - nick decker | email revisions
ADDED
- `decodeHtml()` — decodes HTML entities YouTube API returns in text fields (&#39; → ', &amp; → &, etc.)
- `thumbnailUrl` (medium, 320×180) extracted in all fetch functions and included in `VideoMeta`

CHANGED
- All `itemToMeta`, `searchItemToMeta`, and `getPlaylistVideos` map functions now run `decodeHtml()` on title, channel, and description, and capture `thumbnailUrl`

5/22/2026 - nick decker | refactor
CHANGED
- `getYouTube()` exported so backfill.ts can reuse it instead of instantiating its own YouTube client
*/

import { youtube } from "@googleapis/youtube";
import type { VideoMeta, TopComment } from "./db.js";
import { upsertTopicLabels } from "./db.js";
import { decodeHtml } from "./utils.js";

export function getYouTube() {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) throw new Error("YOUTUBE_API_KEY is not set in .env");
  return youtube({ version: "v3", auth: apiKey });
}

export async function getCategories(
  regionCode = "US"
): Promise<{ id: string; title: string }[]> {
  const yt = getYouTube();
  const res = await yt.videoCategories.list({
    part: ["snippet"],
    regionCode,
  });
  return (res.data.items ?? [])
    .filter((item) => item.snippet?.assignable)
    .map((item) => ({ id: item.id ?? "", title: item.snippet?.title ?? "" }))
    .sort((a, b) => parseInt(a.id) - parseInt(b.id));
}

export async function resolveHandle(handle: string): Promise<string | null> {
  const yt = getYouTube();
  const h = handle.startsWith("@") ? handle.slice(1) : handle;
  // forHandle is valid at runtime but missing from the googleapis type definitions
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await yt.channels.list({ part: ["id"], forHandle: h } as any);
  return (res as any).data?.items?.[0]?.id ?? null;
}

export function extractPlaylistId(input: string): string {
  try {
    const url = new URL(input);
    return url.searchParams.get("list") ?? input;
  } catch {
    return input;
  }
}

export async function getPlaylistVideos(
  playlistId: string,
  n = 5
): Promise<VideoMeta[]> {
  const yt = getYouTube();
  const res = await yt.playlistItems.list({
    part: ["snippet"],
    playlistId,
    maxResults: n,
  });
  return (res.data.items ?? [])
    .filter((item) => item.snippet?.resourceId?.videoId)
    .map((item) => ({
      id: item.snippet!.resourceId!.videoId!,
      title: decodeHtml(item.snippet?.title ?? "(no title)"),
      channel: decodeHtml(item.snippet?.videoOwnerChannelTitle ?? item.snippet?.channelTitle ?? "(unknown)"),
      publishedAt: item.snippet?.publishedAt ?? "",
      description: decodeHtml(item.snippet?.description ?? ""),
      thumbnailUrl: (item.snippet?.thumbnails as { medium?: { url?: string } } | null)?.medium?.url ?? undefined,
    }));
}

export async function getUploadsPlaylistId(channelId: string): Promise<string | null> {
  const yt = getYouTube();
  const res = await yt.channels.list({ part: ["contentDetails"], id: [channelId] });
  return res.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads ?? null;
}

export async function getTopComments(videoId: string, n = 2): Promise<TopComment[]> {
  const yt = getYouTube();
  try {
    const res = await yt.commentThreads.list({
      part: ["snippet"],
      videoId,
      order: "relevance",
      maxResults: n,
    });
    return (res.data.items ?? []).map((item) => {
      const s = item.snippet?.topLevelComment?.snippet;
      return {
        author: decodeHtml(s?.authorDisplayName ?? ""),
        text: decodeHtml(s?.textDisplay ?? ""),
        likes: s?.likeCount ?? 0,
      };
    });
  } catch {
    // Comments disabled or unavailable — not worth failing the whole pipeline
    return [];
  }
}

export async function getVideoSignals(
  ids: string[]
): Promise<Record<string, { categoryId: string; topicCategories: string[] }>> {
  if (ids.length === 0) return {};
  const yt = getYouTube();
  const res = await yt.videos.list({ part: ["snippet", "topicDetails"], id: ids });
  const out: Record<string, { categoryId: string; topicCategories: string[] }> = {};
  const allLabels: { label: string; url: string }[] = [];
  for (const item of res.data.items ?? []) {
    if (!item.id) continue;
    const topicUrls: string[] = (item as any).topicDetails?.topicCategories ?? [];
    const topicCategories = topicUrls.map((url: string) => {
      const parts = url.split("/wiki/");
      return decodeURIComponent(parts[parts.length - 1]).replace(/_/g, " ");
    });
    for (let i = 0; i < topicUrls.length; i++) {
      allLabels.push({ label: topicCategories[i], url: topicUrls[i] });
    }
    out[item.id] = {
      categoryId: item.snippet?.categoryId ?? "",
      topicCategories,
    };
  }
  upsertTopicLabels(allLabels);
  return out;
}

export async function getTrending(
  n = 5,
  regionCode = "US",
  categoryId?: string
): Promise<VideoMeta[]> {
  const youtube = getYouTube();
  const res = await youtube.videos.list({
    part: ["snippet", "topicDetails"],
    chart: "mostPopular",
    regionCode,
    videoCategoryId: categoryId,
    maxResults: n,
  });
  const trendingLabels: { label: string; url: string }[] = [];
  const items = (res.data.items ?? []).map((item) => {
    const meta = itemToMeta(item);
    const topicUrls: string[] = (item as any).topicDetails?.topicCategories ?? [];
    meta.categoryId = item.snippet?.categoryId ?? undefined;
    meta.topicCategories = topicUrls.map((url: string) => {
      const parts = url.split("/wiki/");
      const label = decodeURIComponent(parts[parts.length - 1]).replace(/_/g, " ");
      trendingLabels.push({ label, url });
      return label;
    });
    return meta;
  });
  upsertTopicLabels(trendingLabels);
  return items;
}

export async function getChannelVideos(
  channelId: string,
  n = 5
): Promise<VideoMeta[]> {
  const youtube = getYouTube();
  const res = await youtube.search.list({
    part: ["snippet"],
    channelId,
    order: "date",
    type: ["video"],
    maxResults: n,
  });
  return (res.data.items ?? []).map(searchItemToMeta);
}

export async function searchVideos(
  query: string,
  n = 5
): Promise<VideoMeta[]> {
  const youtube = getYouTube();
  const res = await youtube.search.list({
    part: ["snippet"],
    q: query,
    order: "relevance",
    type: ["video"],
    maxResults: n,
  });
  return (res.data.items ?? []).map(searchItemToMeta);
}

export async function getVideoDurations(ids: string[]): Promise<Record<string, number>> {
  if (ids.length === 0) return {};
  const yt = getYouTube();
  const res = await yt.videos.list({ part: ["contentDetails"], id: ids });
  const out: Record<string, number> = {};
  for (const item of res.data.items ?? []) {
    if (!item.id || !item.contentDetails?.duration) continue;
    out[item.id] = parseIsoDuration(item.contentDetails.duration);
  }
  return out;
}

export function isShort(durationSeconds: number): boolean {
  return durationSeconds < 62;
}

function parseIsoDuration(iso: string): number {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] ?? "0") * 3600) + (parseInt(m[2] ?? "0") * 60) + parseInt(m[3] ?? "0");
}

function itemToMeta(item: {
  id?: string | null;
  snippet?: {
    title?: string | null;
    channelTitle?: string | null;
    publishedAt?: string | null;
    description?: string | null;
    thumbnails?: { medium?: { url?: string | null } | null } | null;
  } | null;
}): VideoMeta {
  return {
    id: item.id ?? "",
    title: decodeHtml(item.snippet?.title ?? "(no title)"),
    channel: decodeHtml(item.snippet?.channelTitle ?? "(unknown)"),
    publishedAt: item.snippet?.publishedAt ?? "",
    description: decodeHtml(item.snippet?.description ?? ""),
    thumbnailUrl: item.snippet?.thumbnails?.medium?.url ?? undefined,
  };
}

function searchItemToMeta(item: {
  id?: { videoId?: string | null } | null;
  snippet?: {
    title?: string | null;
    channelTitle?: string | null;
    publishedAt?: string | null;
    description?: string | null;
    thumbnails?: { medium?: { url?: string | null } | null } | null;
  } | null;
}): VideoMeta {
  return {
    id: item.id?.videoId ?? "",
    title: decodeHtml(item.snippet?.title ?? "(no title)"),
    channel: decodeHtml(item.snippet?.channelTitle ?? "(unknown)"),
    publishedAt: item.snippet?.publishedAt ?? "",
    description: decodeHtml(item.snippet?.description ?? ""),
    thumbnailUrl: item.snippet?.thumbnails?.medium?.url ?? undefined,
  };
}
