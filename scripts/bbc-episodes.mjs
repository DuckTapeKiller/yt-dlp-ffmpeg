#!/usr/bin/env node
// List every episode of a BBC brand or series.
//
//   node bbc-episodes.mjs <url-or-pid> [outputDir] [--urls-only]
//
// Accepts /sounds/brand/<pid>, /sounds/series/<pid>, /programmes/<pid>, or a
// bare pid. Walks the paginated episode index, which yt-dlp does not do — it
// reads page 1 only.
//
// Prints one programme URL per line on stdout, so the output can be piped or
// pasted straight back into the downloader. Also writes a Markdown listing
// unless --urls-only is given.

import { writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const PID_RE = /^[bmpw][0-9a-z]{7,}$/i;
const MAX_PAGES = 100;
const DATE_CONCURRENCY = 6;

function pidFrom(input) {
  const direct = input.trim();
  if (PID_RE.test(direct)) return direct;
  try {
    const segments = new URL(direct).pathname.split("/").filter(Boolean);
    const pid = segments[segments.length - 1];
    if (pid && PID_RE.test(pid)) return pid;
  } catch {
    /* fall through */
  }
  return undefined;
}

async function getText(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function decodeEntities(value) {
  return value
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// One <div class="programme ..."> block per episode on the index page.
function parseEpisodes(html, brandPid) {
  const found = new Map();
  const titleRe =
    /<h2 class="programme__titles"><a href="[^"]*\/programmes\/([bmpw][0-9a-z]{7,})"[\s\S]{0,300}?<span class="programme__title[^"]*"><span>([\s\S]*?)<\/span>/g;
  for (const match of html.matchAll(titleRe)) {
    const [, pid, rawTitle] = match;
    if (pid === brandPid || found.has(pid)) continue;
    found.set(pid, {
      pid,
      title: decodeEntities(rawTitle.replace(/<[^>]+>/g, "")).trim(),
      availability: "",
    });
  }
  // "1 month left to listen (Sun 11 October 2026, 23:30)" hangs off the play link.
  const availRe =
    /<a href="[^"]*\/sounds\/play\/([bmpw][0-9a-z]{7,})"\s+title="([^"]*)"/g;
  for (const match of html.matchAll(availRe)) {
    const entry = found.get(match[1]);
    if (entry && !entry.availability)
      entry.availability = decodeEntities(match[2]).trim();
  }
  return [...found.values()];
}

function totalPages(html) {
  let max = 1;
  for (const match of html.matchAll(/Page\s+(\d+)\s+of\s+(\d+)/gi))
    max = Math.max(max, Number(match[2]) || 1);
  return max;
}

async function broadcastDate(pid) {
  try {
    const res = await fetch(`https://www.bbc.co.uk/programmes/${pid}.json`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return "";
    const programme = (await res.json()).programme ?? {};
    return String(programme.first_broadcast_date ?? "").slice(0, 10);
  } catch {
    return "";
  }
}

async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await fn(items[index]);
      }
    }),
  );
  return results;
}

const args = process.argv.slice(2);
const urlsOnly = args.includes("--urls-only");
const positional = args.filter((a) => !a.startsWith("--"));
const input = positional[0];
const outputDir = positional[1] || join(homedir(), "Downloads");

if (!input) {
  console.error("usage: node bbc-episodes.mjs <url-or-pid> [outputDir] [--urls-only]");
  process.exit(2);
}
const brandPid = pidFrom(input);
if (!brandPid) {
  console.error(`Could not find a BBC programme id in: ${input}`);
  process.exit(2);
}

const base = `https://www.bbc.co.uk/programmes/${brandPid}/episodes/player`;
const episodes = [];
const seen = new Set();
let pages = 1;

for (let page = 1; page <= Math.min(pages, MAX_PAGES); page += 1) {
  let html;
  try {
    html = await getText(`${base}?page=${page}`);
  } catch (error) {
    // Page 1 failing means the brand does not exist or is unreachable; a later
    // page failing just ends the walk with what we already have.
    if (page === 1) {
      console.error(`Could not read the episode index for ${brandPid}: ${error.message}`);
      process.exit(1);
    }
    console.error(`Stopped at page ${page}: ${error.message}`);
    break;
  }
  if (page === 1) pages = totalPages(html);
  const batch = parseEpisodes(html, brandPid).filter((e) => !seen.has(e.pid));
  if (batch.length === 0) break;
  for (const episode of batch) {
    seen.add(episode.pid);
    episodes.push(episode);
  }
}

const dates = await mapLimited(episodes, DATE_CONCURRENCY, (e) =>
  broadcastDate(e.pid),
);
episodes.forEach((episode, index) => {
  episode.date = dates[index] || "";
});
episodes.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

for (const episode of episodes)
  console.log(`https://www.bbc.co.uk/programmes/${episode.pid}`);

if (urlsOnly) process.exit(0);

let brandTitle = brandPid;
try {
  const meta = await (
    await fetch(`https://www.bbc.co.uk/programmes/${brandPid}.json`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    })
  ).json();
  brandTitle = meta.programme?.title ?? brandPid;
} catch {
  /* keep the pid as the heading */
}

const cell = (v) =>
  String(v ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();

const lines = [
  `# ${brandTitle} — episodes`,
  "",
  `${episodes.length} episode${episodes.length === 1 ? "" : "s"} across ${pages} page${pages === 1 ? "" : "s"} of the index.`,
  "",
  `[Brand page](https://www.bbc.co.uk/sounds/brand/${brandPid}) · [Episode index](${base})`,
  "",
  "| Date | Episode | URL | Availability |",
  "|---|---|---|---|",
];
for (const episode of episodes) {
  const url = `https://www.bbc.co.uk/programmes/${episode.pid}`;
  lines.push(
    `| ${cell(episode.date)} | ${cell(episode.title)} | [${episode.pid}](${url}) | ${cell(episode.availability)} |`,
  );
}
lines.push("", "---", "", "Only episodes still inside their listen window can be downloaded.", "");

await mkdir(outputDir, { recursive: true });
const outPath = join(outputDir, `${brandTitle.replace(/[/\\:*?"<>|]/g, "-")} — episodes.md`);
await writeFile(outPath, lines.join("\n"), "utf8");
console.error(`\n${episodes.length} episodes -> ${outPath}`);
