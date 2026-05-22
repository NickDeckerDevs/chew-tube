import { youtube } from "@googleapis/youtube";
import type { VideoMeta } from "./db.js";

function getYouTube() {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) throw new Error("YOUTUBE_API_KEY is not set in .env");
  return youtube({ version: "v3", auth: apiKey });
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
  } | null;
}): VideoMeta {
  return {
    id: item.id ?? "",
    title: item.snippet?.title ?? "(no title)",
    channel: item.snippet?.channelTitle ?? "(unknown)",
    publishedAt: item.snippet?.publishedAt ?? "",
    description: item.snippet?.description ?? "",
  };
}

function searchItemToMeta(item: {
  id?: { videoId?: string | null } | null;
  snippet?: {
    title?: string | null;
    channelTitle?: string | null;
    publishedAt?: string | null;
    description?: string | null;
  } | null;
}): VideoMeta {
  return {
    id: item.id?.videoId ?? "",
    title: item.snippet?.title ?? "(no title)",
    channel: item.snippet?.channelTitle ?? "(unknown)",
    publishedAt: item.snippet?.publishedAt ?? "",
    description: item.snippet?.description ?? "",
  };
}
