#!/usr/bin/env node
// Big J MCP server (stdio): X posting + Facebook group scraping
// Tools: x_whoami, x_post_tweet, fb_fetch_candidates, image_reverse_prompt, post_history
// Credentials come from env: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
// Optional: X_DRY_RUN=1 -> never actually posts (for testing)
// FB: APIFY_TOKEN, APIFY_TASK_ID
// Vision: GRAFILAB_API_KEY (optional GRAFILAB_VISION_MODEL)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TwitterApi } from "twitter-api-v2";
import { z } from "zod";
import { fetchCandidates } from "./fb.js";
import { reversePrompt } from "./vision.js";
import { recordPost, recentHistory, HISTORY_FILE } from "./history.js";

const log = (...a) => console.error("[bigj-mcp]", ...a); // stderr only; stdout is the MCP channel

const DRY_RUN = ["1", "true", "yes"].includes(String(process.env.X_DRY_RUN || "").toLowerCase());
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // X limit for images

function getClient() {
  const need = ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"];
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Missing env: ${missing.join(", ")}`);
  return new TwitterApi({
    appKey: process.env.X_API_KEY,
    appSecret: process.env.X_API_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_SECRET,
  });
}

function explain(err) {
  const code = err?.code ?? err?.data?.status;
  if (!err?.data && !code) return err?.message || String(err); // not an X API error
  const detail = err?.data?.detail || err?.data?.title || err?.message || String(err);
  const hints = {
    401: "Unauthorized: check the 4 keys/tokens.",
    403: "Forbidden: app permission must be 'Read and write', then REGENERATE the access token/secret. Also check duplicate text or your API plan.",
    429: "Rate limited / quota used up. Wait and retry later.",
  };
  const d = err?.data || {};
  const diag = [d.reason && `reason=${d.reason}`, d.client_id && `client_id=${d.client_id}`, d.type && `type=${d.type}`]
    .filter(Boolean).join(" ");
  const keyTail = (process.env.X_API_KEY || "").slice(-4);
  return `X API error${code ? " " + code : ""}: ${detail}${diag ? " | " + diag : ""} | using api_key ...${keyTail}${hints[code] ? " | Hint: " + hints[code] : ""}`;
}

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8",
};

// Download an image robustly: browser-like headers, then Grafilab key if needed, with one retry.
async function downloadImage(url) {
  const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  const attempts = [{ ...BROWSER_HEADERS }];
  if (/grafilab/i.test(host) && process.env.GRAFILAB_API_KEY) {
    attempts.push({ ...BROWSER_HEADERS, Authorization: `Bearer ${process.env.GRAFILAB_API_KEY}` });
  }
  attempts.push({ ...BROWSER_HEADERS }); // plain retry (transient errors)

  const errors = [];
  for (let i = 0; i < attempts.length; i++) {
    try {
      if (i > 0) await new Promise((r) => setTimeout(r, 1500));
      const res = await fetch(url, { headers: attempts[i], redirect: "follow" });
      if (!res.ok) {
        const snippet = (await res.text().catch(() => "")).slice(0, 120).replace(/\s+/g, " ");
        errors.push(`try${i + 1}: HTTP ${res.status} ${snippet}`);
        continue;
      }
      let mime = (res.headers.get("content-type") || "").split(";")[0].trim();
      const buf = Buffer.from(await res.arrayBuffer());
      if (!mime.startsWith("image/")) {
        if (buf[0] === 0x89 && buf[1] === 0x50) mime = "image/png";
        else if (buf[0] === 0xff && buf[1] === 0xd8) mime = "image/jpeg";
        else if (buf.slice(0, 4).toString() === "RIFF") mime = "image/webp";
        else if (buf.slice(0, 3).toString() === "GIF") mime = "image/gif";
        else { errors.push(`try${i + 1}: not an image (content-type: ${mime || "unknown"})`); continue; }
      }
      if (buf.length > MAX_IMAGE_BYTES) throw new Error(`Image is ${(buf.length / 1e6).toFixed(1)}MB, X limit is 5MB. Generate a smaller size.`);
      return { buf, mime };
    } catch (e) {
      if (/X limit/.test(e.message)) throw e;
      errors.push(`try${i + 1}: ${e?.cause?.code || e.message}`);
    }
  }
  throw new Error(`Image download failed for ${host}: ${errors.join(" | ")}`);
}

async function uploadMedia(client, buf, mime) {
  // Prefer v2 media upload; fall back to v1.1 if unavailable
  try {
    if (client.v2.uploadMedia) return await client.v2.uploadMedia(buf, { media_type: mime });
  } catch (e) {
    log("v2 upload failed, trying v1.1:", e?.message);
  }
  return await client.v1.uploadMedia(buf, { mimeType: mime });
}

const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ content: [{ type: "text", text: JSON.stringify({ status: "failed", error: msg }) }], isError: true });

const server = new McpServer({ name: "bigj-mcp", version: "1.0.0" });

server.tool(
  "x_whoami",
  "Check which X account the credentials belong to. Use this to verify the setup before posting.",
  {},
  async () => {
    try {
      const me = await getClient().v2.me();
      return ok({ id: me.data.id, username: me.data.username, name: me.data.name, dry_run: DRY_RUN });
    } catch (e) {
      return fail(explain(e));
    }
  }
);

server.tool(
  "x_post_tweet",
  "Publish a tweet to X, optionally with one image (by URL) and optionally as a reply (for threads). Returns the tweet URL.",
  {
    text: z.string().min(1).describe("Tweet text, max 280 characters (CJK counts double)"),
    image_url: z.string().url().optional().describe("Public URL of an image to attach"),
    reply_to_tweet_id: z.string().optional().describe("Tweet ID to reply to, to build a thread"),
    source_url: z.string().optional().describe("Facebook source post URL. Pass it on the MAIN post so it is never reused."),
    source_image_url: z.string().optional().describe("Original Facebook image URL, if known"),
    final_prompt: z.string().optional().describe("The final image prompt, saved to post history"),
  },
  async ({ text, image_url, reply_to_tweet_id, source_url, source_image_url, final_prompt }) => {
    // Models sometimes send a literal backslash-n instead of a real line break; fix it so the tweet looks right.
    text = String(text).replace(/\\r\\n|\\n/g, "\n").trim();
    const remember = (status, extra = {}) => {
      if (reply_to_tweet_id) return; // replies (thread parts) are not separate posts
      try { recordPost({ status, source_url, source_image_url, final_prompt, text, ...extra }); }
      catch (e) { log("history write failed:", e.message); }
    };
    try {
      const client = getClient();
      let media_id, image_info;
      if (image_url) {
        const { buf, mime } = await downloadImage(image_url);
        image_info = { mime, bytes: buf.length };
        if (DRY_RUN) {
          media_id = "dry-run-media";
        } else {
          media_id = await uploadMedia(client, buf, mime);
        }
      }
      const payload = { text };
      if (media_id) payload.media = { media_ids: [media_id] };
      if (reply_to_tweet_id) payload.reply = { in_reply_to_tweet_id: reply_to_tweet_id };

      if (DRY_RUN) {
        remember("dry_run");
        return ok({ status: "dry_run", would_post: payload, image_download: image_info || "no image", recorded_in_history: !reply_to_tweet_id, note: "X_DRY_RUN is on, nothing was posted." });
      }

      const res = await client.v2.tweet(payload);
      const id = res.data.id;
      let username = process.env.X_USERNAME;
      if (!username) {
        try { username = (await client.v2.me()).data.username; } catch { username = "i"; }
      }
      const tweet_url = `https://x.com/${username}/status/${id}`;
      remember("posted", { tweet_id: id, tweet_url });
      return ok({ status: "posted", tweet_id: id, tweet_url });
    } catch (e) {
      return fail(explain(e));
    }
  }
);

server.tool(
  "fb_fetch_candidates",
  "Scrape the latest posts from the Big J source Facebook groups (via Apify) and return a compact list of IMAGE posts only (videos, text-only posts and posts Big J already published are removed). Each item: post_url, text, image_urls, likes, comments.",
  {
    fresh: z.boolean().optional().describe("true (default) = run a new scrape (costs ~USD 0.15). false = reuse the last scrape for free, good for testing."),
    limit: z.number().int().min(1).max(30).optional().describe("Max posts to return, default 15"),
  },
  async ({ fresh = true, limit = 15 }) => {
    try {
      return ok(await fetchCandidates({ fresh, limit, dryRun: DRY_RUN }));
    } catch (e) {
      return fail(e?.name === "AbortError" ? "Apify scrape timed out (>290s). Try fresh=false or lower resultsLimit in the Apify task." : e?.message || String(e));
    }
  }
);

server.tool(
  "image_reverse_prompt",
  "Look at an image (by URL) with a vision model and return a prompt that would recreate it, plus funny/sexy/creative scores and a safety check. Use this when a post has no prompt in its text.",
  {
    image_url: z.string().url().describe("Image URL, e.g. from fb_fetch_candidates"),
    language: z.enum(["en", "zh"]).optional().describe("Language of the prompt to write, default en"),
    post_text: z.string().optional().describe("Original post text, as extra context"),
  },
  async (args) => {
    try { return ok(await reversePrompt(args)); }
    catch (e) { return fail(e?.message || String(e)); }
  }
);

server.tool(
  "post_history",
  "List Big J's most recent posts (newest first): source_url, final_prompt, tweet_url. Use it to avoid posting an idea too similar to a recent one.",
  { limit: z.number().int().min(1).max(50).optional().describe("How many, default 15") },
  async ({ limit = 15 }) => {
    try { return ok({ history_file: HISTORY_FILE, dry_run_mode: DRY_RUN, posts: recentHistory(limit, DRY_RUN) }); }
    catch (e) { return fail(e?.message || String(e)); }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready${DRY_RUN ? " (DRY RUN)" : ""}`);
