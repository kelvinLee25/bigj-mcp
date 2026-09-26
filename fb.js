// Facebook group scraping via an Apify Task, returning a compact, image-only list.
// Env: APIFY_TOKEN, APIFY_TASK_ID (e.g. "kelvin~bigj-fb-groups" or the task's ID)

import { usedSourceKeys, normUrl } from "./history.js";

const APIFY = process.env.APIFY_BASE || "https://api.apify.com/v2";

const isVideo = (a) => /video/i.test(a?.__typename || "") || a?.videoId || a?.playable_duration_in_ms;

// Pick the best image URL from one attachment, whatever shape Apify gives us
function imageFrom(a) {
  if (!a || typeof a !== "object") return null;
  const cands = [
    a.photo_image?.uri,
    a.image?.uri,
    a.media?.image?.uri,
    a.preferred_thumbnail?.image?.uri,
    a.thumbnailImage?.uri,
    a.thumbnail,
    typeof a.image === "string" ? a.image : null,
  ];
  return cands.find((u) => typeof u === "string" && /^https?:\/\//.test(u)) || null;
}

// Also handle posts that list media under other keys (media, images, photos)
function collectAttachments(item) {
  const lists = [item.attachments, item.media, item.images, item.photos].filter(Array.isArray);
  return lists.flat();
}

export function compactPosts(items, { maxTextChars = 1200 } = {}) {
  const out = [];
  for (const it of items || []) {
    const atts = collectAttachments(it);
    if (!atts.length) continue; // text-only post
    if (atts.some(isVideo)) continue; // IMAGE ONLY: skip any post containing video
    const images = [...new Set(atts.map(imageFrom).filter(Boolean))];
    if (!images.length) continue;
    const text = String(it.text || it.message || "").trim();
    out.push({
      post_url: it.url || it.postUrl || it.permalink || it.facebookUrl || null,
      group_url: it.facebookUrl || null,
      text: text.length > maxTextChars ? text.slice(0, maxTextChars) + "…" : text,
      image_urls: images.slice(0, 4),
      likes: it.likesCount ?? null,
      comments: it.commentsCount ?? null,
      posted_at: it.time || it.date || null,
    });
  }
  return out;
}

export async function fetchCandidates({ fresh = true, limit = 15, maxTextChars = 1200, dryRun = false } = {}) {
  const token = process.env.APIFY_TOKEN;
  const task = process.env.APIFY_TASK_ID;
  if (!token || !task) throw new Error("Missing env: APIFY_TOKEN and/or APIFY_TASK_ID");
  const id = encodeURIComponent(task);
  const url = fresh
    ? `${APIFY}/actor-tasks/${id}/run-sync-get-dataset-items?clean=true`
    : `${APIFY}/actor-tasks/${id}/runs/last/dataset/items?clean=true&status=SUCCEEDED`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 290_000);
  let res;
  try {
    res = await fetch(url, {
      method: fresh ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: fresh ? "{}" : undefined,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`Apify HTTP ${res.status}: ${body}`);
  }
  const items = await res.json();
  const all = compactPosts(items, { maxTextChars });
  const used = usedSourceKeys(dryRun);
  const posts = all.filter((p) => !used.has(normUrl(p.post_url)) && !p.image_urls.some((u) => used.has(normUrl(u))));
  const skipped_already_posted = all.length - posts.length;
  // most-engaged first
  posts.sort((a, b) => (b.likes || 0) + (b.comments || 0) * 2 - ((a.likes || 0) + (a.comments || 0) * 2));
  return { scraped: items.length, image_posts: all.length, skipped_already_posted, posts: posts.slice(0, limit) };
}
