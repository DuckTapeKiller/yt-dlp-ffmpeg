#!/usr/bin/env node
// Build a Markdown tracklist for a BBC programme.
//
//   node bbc-tracklist.mjs <url-or-pid> [outputDir]
//
// Accepts /sounds/play/<pid>, /programmes/<pid>, or a bare pid. Reads BBC's
// own segments API rather than scraping the player, which is JavaScript-rendered
// and carries no tracklist in its served HTML.

import { writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const PID_RE = /^[bmpw][0-9a-z]{7,}$/i;

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

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function hms(totalSeconds) {
  if (!Number.isFinite(totalSeconds)) return "";
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

// Pipes and newlines would break the table row they sit in.
function cell(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function safeFilename(value) {
  return value
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
}

const rawArgs = process.argv.slice(2);
const outFlag = rawArgs.indexOf("--out");
const outputDir =
  outFlag >= 0 ? rawArgs[outFlag + 1] : join(homedir(), "Downloads");
const inputs = rawArgs.filter(
  (arg, index) =>
    !arg.startsWith("--") && index !== outFlag + 1 && !arg.startsWith("-"),
);

// Also accept a list piped in, so it composes with bbc-episodes.mjs.
if (!process.stdin.isTTY) {
  const piped = await new Promise((resolve) => {
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (buffer += chunk));
    process.stdin.on("end", () => resolve(buffer));
    process.stdin.on("error", () => resolve(""));
  });
  for (const line of piped.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) inputs.push(trimmed);
  }
}

if (inputs.length === 0) {
  console.error(
    "usage: node bbc-tracklist.mjs <url-or-pid>... [--out <dir>]   (also reads stdin)",
  );
  process.exit(2);
}

await mkdir(outputDir, { recursive: true });

let written = 0;
const noTracklist = [];
const failed = [];

for (const input of inputs) {
  const pid = pidFrom(input);
  if (!pid) {
    failed.push(`${input} (no programme id)`);
    continue;
  }
  let meta;
  let segments;
  try {
    [meta, segments] = await Promise.all([
      getJson(`https://www.bbc.co.uk/programmes/${pid}.json`),
      getJson(`https://www.bbc.co.uk/programmes/${pid}/segments.json`),
    ]);
  } catch (error) {
    failed.push(`${pid} (${error.message})`);
    continue;
  }

  const programme = meta.programme ?? {};
  const parentTitle = programme.parent?.programme?.title ?? "";
  const episodeTitle = programme.title ?? pid;
  const heading = parentTitle
    ? `${parentTitle} — ${episodeTitle}`
    : episodeTitle;
  const firstBroadcast = programme.first_broadcast_date
    ? String(programme.first_broadcast_date).slice(0, 10)
    : "";
  const station = programme.ownership?.service?.title ?? "";
  const durationSeconds = Number(programme.duration);

  const events = (segments.segment_events ?? []).filter(
    (event) => event?.segment?.type === "music",
  );
  if (events.length === 0) {
    noTracklist.push(`${pid} — ${heading}`);
    continue;
  }

  const lines = [`# ${heading}`, ""];
  const facts = [];
  if (firstBroadcast) facts.push(`**Broadcast** ${firstBroadcast}`);
  if (Number.isFinite(durationSeconds))
    facts.push(`**Duration** ${hms(durationSeconds)}`);
  if (station) facts.push(`**Station** ${station}`);
  if (facts.length) lines.push(facts.join(" · "), "");
  lines.push(
    `[Programme page](https://www.bbc.co.uk/programmes/${pid}) · ` +
      `[BBC Sounds](https://www.bbc.co.uk/sounds/play/${pid})`,
    "",
    `## Tracklist (${events.length})`,
    "",
    "| # | Time | Artist | Track | Release | Label |",
    "|---:|---|---|---|---|---|",
  );
  events.forEach((event, index) => {
    const seg = event.segment ?? {};
    lines.push(
      `| ${event.position ?? index + 1} | ${hms(Number(event.version_offset))} | ` +
        `${cell(seg.artist)} | ${cell(seg.track_title)} | ` +
        `${cell(seg.release_title)} | ${cell(seg.record_label)} |`,
    );
  });
  lines.push("", "---", "", `Tracklist data from BBC programme \`${pid}\`.`, "");

  // Match the audio filename yt-dlp writes, so the pair sorts together.
  const stamp = firstBroadcast ? firstBroadcast.replace(/-/g, ".") : "UnknownDate";
  const audioStyleTitle = parentTitle
    ? `${parentTitle}, ${episodeTitle}`
    : episodeTitle;
  const outPath = join(
    outputDir,
    `${safeFilename(`${stamp} — ${audioStyleTitle}`)}.md`,
  );
  await writeFile(outPath, lines.join("\n"), "utf8");
  written += 1;
  console.log(`${String(events.length).padStart(3)} tracks  ${outPath.replace(/^.*\//, "")}`);
}

console.error(`\nWrote ${written}/${inputs.length} tracklists to ${outputDir}`);
if (noTracklist.length)
  console.error(`No tracklist published (${noTracklist.length}):\n  ${noTracklist.join("\n  ")}`);
if (failed.length) {
  console.error(`Failed (${failed.length}):\n  ${failed.join("\n  ")}`);
  // Non-zero so a caller in a pipeline notices. A programme that simply has no
  // published tracklist is a valid result, not a failure, and does not count.
  process.exit(1);
}
