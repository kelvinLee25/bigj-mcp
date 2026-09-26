// Post history for de-duplication. Stored OUTSIDE the git repo so `git pull` never touches it.
// Default: <repo>/../bigj-history.json  (e.g. /opt/data/mcp/bigj-history.json)
// Override with env BIGJ_HISTORY_FILE.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const HISTORY_FILE = process.env.BIGJ_HISTORY_FILE || path.resolve(here, "..", "bigj-history.json");

// Normalise FB URLs so the same post always matches (drop query string, trailing slash, host variants)
export function normUrl(u) {
  if (!u) return "";
  try {
    const x = new URL(u);
    return (x.hostname.replace(/^(www\.|m\.|web\.)/, "") + x.pathname).replace(/\/+$/, "").toLowerCase();
  } catch {
    return String(u).trim().toLowerCase();
  }
}

export function loadHistory() {
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function saveHistory(list) {
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  const tmp = HISTORY_FILE + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(list.slice(-500), null, 2)); // keep last 500
  fs.renameSync(tmp, HISTORY_FILE);
}

export function recordPost(entry) {
  const list = loadHistory();
  list.push({ at: new Date().toISOString(), ...entry });
  saveHistory(list);
}

// In dry-run mode, dry-run records also count (so de-dup can be tested); live mode only counts real posts.
export function usedSourceKeys(dryRun) {
  const keys = new Set();
  for (const h of loadHistory()) {
    if (h.status === "posted" || (dryRun && h.status === "dry_run")) {
      if (h.source_url) keys.add(normUrl(h.source_url));
      if (h.source_image_url) keys.add(normUrl(h.source_image_url));
    }
  }
  return keys;
}

export function recentHistory(limit = 20, dryRun = false) {
  return loadHistory()
    .filter((h) => h.status === "posted" || (dryRun && h.status === "dry_run"))
    .slice(-limit)
    .reverse()
    .map(({ at, status, source_url, final_prompt, tweet_url }) => ({ at, status, source_url, final_prompt, tweet_url }));
}