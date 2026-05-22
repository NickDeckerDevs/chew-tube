/*
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

export async function getTrending(
  n = 5,
  regionCode = "US",
  categoryId?: string
): Promise<VideoMeta[]> {
  const youtube = getYouTube();
  const res = await youtube.videos.list({
    part: ["snippet"],
    chart: "mostPopular",
    regionCode,
    videoCategoryId: categoryId,
    maxResults: n,
  });
  return (res.data.items ?? []).map(itemToMeta);
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
