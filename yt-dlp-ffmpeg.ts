import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { type Static, StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  type Component,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

const AUDIO_FORMATS = [
  "best",
  "aac",
  "alac",
  "flac",
  "m4a",
  "mp3",
  "opus",
  "vorbis",
  "wav",
] as const;
const VIDEO_CONTAINERS = ["mkv", "mp4", "webm", "mov"] as const;
const PLAYLIST_MODES = ["single", "playlist"] as const;
const OVERWRITE_MODES = ["skip", "overwrite"] as const;
const COOKIE_BROWSERS = [
  "none",
  "safari",
  "chrome",
  "chromium",
  "firefox",
  "edge",
  "brave",
  "vivaldi",
] as const;
const DOWNLOAD_COMPATIBILITY_PROFILES = ["source", "mac-lg-tv"] as const;
const MEDIA_PREVIEW_MAX_ENTRIES = 500;
const MEDIA_PREVIEW_METADATA_CONCURRENCY = 4;
const DISCOVERY_RULE_MAX_PATTERN_LENGTH = 4000;
const DISCOVERY_RULE_MAX_ENTRIES = 500;
const DISCOVERY_RULE_FIELDS = new Set([
  "id",
  "url",
  "webpageUrl",
  "link",
  "mediaUrl",
  "file",
  "title",
  "date",
  "duration",
  "thumbnail",
  "description",
]);
const TRANSCODE_ENGINES = ["auto", "ffmpeg", "handbrake"] as const;
const TRANSCODE_AUDIO_MODES = ["copy-ac3-else-aac", "aac", "copy"] as const;
const TRANSCODE_OUTPUT_NAMING = ["same-path", "mp4-extension"] as const;
const TRANSCODE_VIDEO_CODECS = ["libx265", "libx264", "copy"] as const;
const TRANSCODE_PROFILES = [
  "custom",
  "mac-lg-tv-h264",
  "lg-tv-hevc",
  "hevc-archive",
  "handbrake-fast-1080p30",
  "handbrake-hq-1080p30",
  "handbrake-hq-2160p60-4k-hevc",
  "handbrake-apple-compatible",
  "handbrake-lg-tv-compatible",
] as const;
const LOSSLESS_EDIT_MODES = [
  "open-gui",
  "trim",
  "remux",
  "extract-audio",
  "remove-audio",
] as const;
const LOSSLESS_EDIT_ENGINES = ["auto", "ffmpeg-copy", "losslesscut"] as const;
const LOSSLESS_OUTPUT_CONTAINERS = [
  "mp4",
  "mkv",
  "mov",
  "m4a",
  "aac",
  "mp3",
] as const;
const VIDEO_EXTENSIONS = new Set([
  ".3gp",
  ".avi",
  ".flv",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".mts",
  ".m2ts",
  ".ts",
  ".vob",
  ".webm",
  ".wmv",
]);

const DownloadParamsSchema = Type.Object({
  urls: Type.Array(
    Type.String({ description: "One or more media URLs to download" }),
    {
      minItems: 1,
      description: "List of URLs to download",
    },
  ),
  mode: Type.Optional(
    StringEnum(["audio", "video"] as const, {
      description: "Download mode. Omit to select interactively",
    }),
  ),
  destinationPath: Type.Optional(
    Type.String({
      description: "Absolute destination folder path. Omit to use ~/Downloads",
    }),
  ),
  tracklist: Type.Optional(
    Type.Boolean({
      description:
        "Write a Markdown tracklist beside each downloaded BBC programme that publishes one. Defaults to true; set false only if the user asks for no tracklist.",
    }),
  ),
  audioFormat: Type.Optional(
    StringEnum(AUDIO_FORMATS, {
      description:
        "Audio extension for mode=audio. Do NOT set this unless the user named a format themselves. Leaving it unset keeps the original audio stream with no re-encode, which is what almost every request wants; setting mp3, opus, or vorbis re-encodes already-lossy audio a second time and permanently degrades it.",
    }),
  ),
  videoContainer: Type.Optional(
    StringEnum(VIDEO_CONTAINERS, {
      description:
        "Final video container when mode=video. Omit to choose interactively",
    }),
  ),
  playlistMode: Type.Optional(
    StringEnum(PLAYLIST_MODES, {
      description:
        "How to handle playlist URLs. Omit to choose interactively when playlist URLs are detected",
    }),
  ),
  preview: Type.Optional(
    Type.Boolean({
      description:
        "Show a structured selectable preview before downloading. List-like URLs are previewed automatically.",
    }),
  ),
  maxPlaylistEntries: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MEDIA_PREVIEW_MAX_ENTRIES,
      description:
        "Maximum entries to inspect in a structured preview. Defaults to 500.",
    }),
  ),
  overwriteMode: Type.Optional(
    StringEnum(OVERWRITE_MODES, {
      description: "Whether to overwrite existing files",
    }),
  ),
  cookiesFromBrowser: Type.Optional(
    StringEnum(COOKIE_BROWSERS, {
      description:
        "Load yt-dlp cookies from a local browser profile. Use this for YouTube playlists that require login, captcha, age, or consent state.",
    }),
  ),
  cookiesProfile: Type.Optional(
    Type.String({
      description:
        "Optional browser profile name/path for --cookies-from-browser, e.g. 'Default' or 'Profile 1'. Browser support depends on yt-dlp.",
    }),
  ),
  cookiesFile: Type.Optional(
    Type.String({
      description:
        "Absolute path to a Netscape cookies.txt file to pass with --cookies.",
    }),
  ),
  continueOnErrors: Type.Optional(
    Type.Boolean({
      description:
        "Continue playlist downloads when individual videos fail. Defaults to true for playlist mode and false for single-item mode.",
    }),
  ),
  playlistItems: Type.Optional(
    Type.String({
      description:
        "Optional yt-dlp playlist item spec, e.g. '1-10', '1,3,5', or '10:20'.",
    }),
  ),
  sleepRequests: Type.Optional(
    Type.Number({
      minimum: 0,
      description:
        "Optional delay in seconds between yt-dlp HTTP requests. Useful for YouTube rate/captcha pressure.",
    }),
  ),
  compatibilityProfile: Type.Optional(
    StringEnum(DOWNLOAD_COMPATIBILITY_PROFILES, {
      description:
        "Download compatibility profile. Defaults to mac-lg-tv for video. source keeps best available source behavior.",
    }),
  ),
});

const MediaDiscoveryRuleParamsSchema = Type.Object({
  action: StringEnum(["list", "add", "remove", "test"] as const, {
    description: "Manage declarative generic media discovery rules",
  }),
  name: Type.Optional(Type.String({ description: "Stable rule name" })),
  domain: Type.Optional(
    Type.String({ description: "Hostname or domain matched by the rule" }),
  ),
  urlPattern: Type.Optional(
    Type.String({
      description: "Optional URL substring or re: regular expression",
    }),
  ),
  entryPattern: Type.Optional(
    Type.String({
      description:
        "Regular expression matching one entry block; capture group 1 is the block",
    }),
  ),
  fields: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description:
        "Field-to-regex mappings; regex capture group 1 supplies the value",
    }),
  ),
  url: Type.Optional(
    Type.String({ description: "URL used by the test action" }),
  ),
});

const TranscodeParamsSchema = Type.Object({
  roots: Type.Array(
    Type.String({
      description: "Absolute folder paths to scan for video files",
    }),
    {
      minItems: 1,
      description: "One or more root folders containing videos to transcode",
    },
  ),
  recursive: Type.Optional(
    Type.Boolean({
      description: "Scan subfolders recursively. Defaults to true.",
    }),
  ),
  dryRun: Type.Optional(
    Type.Boolean({
      description:
        "Preview files and commands without transcoding. Defaults to true.",
    }),
  ),
  replaceOriginals: Type.Optional(
    Type.Boolean({
      description:
        "Replace originals after successful transcode. Requires confirmation. Defaults to false.",
    }),
  ),
  outputNaming: Type.Optional(
    StringEnum(TRANSCODE_OUTPUT_NAMING, {
      description:
        "same-path replaces the exact original filename; mp4-extension writes/replaces a .mp4 sibling path. Defaults to same-path when replacing, otherwise mp4-extension.",
    }),
  ),
  engine: Type.Optional(
    StringEnum(TRANSCODE_ENGINES, {
      description:
        "Transcode engine. auto uses HandBrakeCLI for handbrake-* profiles and FFmpeg otherwise. Defaults to auto.",
    }),
  ),
  profile: Type.Optional(
    StringEnum(TRANSCODE_PROFILES, {
      description:
        "Conversion profile. mac-lg-tv-h264 is safest for Mac/LG TVs. handbrake-* profiles require HandBrakeCLI.",
    }),
  ),
  handbrakePreset: Type.Optional(
    Type.String({
      description:
        "Optional HandBrake preset name. Overrides the preset chosen by handbrake-* profile when engine=handbrake.",
    }),
  ),
  videoCodec: Type.Optional(
    StringEnum(TRANSCODE_VIDEO_CODECS, {
      description: "Video codec. Defaults from profile, otherwise libx265.",
    }),
  ),
  crf: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 51,
      description: "libx265 CRF value. Defaults to 23.",
    }),
  ),
  preset: Type.Optional(
    Type.String({
      description:
        "libx265 preset, e.g. medium, slow, slower. Defaults to medium.",
    }),
  ),
  audioMode: Type.Optional(
    StringEnum(TRANSCODE_AUDIO_MODES, {
      description:
        "Audio handling. copy-ac3-else-aac copies AC3 audio and converts other audio to AAC. Defaults to copy-ac3-else-aac.",
    }),
  ),
  audioBitrate: Type.Optional(
    Type.String({
      description: "AAC bitrate when audio is converted. Defaults to 320k.",
    }),
  ),
  audioChannels: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 8,
      description: "AAC channel count when audio is converted. Defaults to 2.",
    }),
  ),
});

const MediaCapabilitiesParamsSchema = Type.Object({});

const LosslessEditParamsSchema = Type.Object({
  input: Type.String({ description: "Absolute input media file path" }),
  mode: StringEnum(LOSSLESS_EDIT_MODES, {
    description:
      "Lossless edit operation. open-gui opens LosslessCut; other modes use FFmpeg stream copy.",
  }),
  engine: Type.Optional(
    StringEnum(LOSSLESS_EDIT_ENGINES, {
      description:
        "Execution engine. auto uses LosslessCut for open-gui and ffmpeg-copy otherwise.",
    }),
  ),
  output: Type.Optional(
    Type.String({
      description:
        "Absolute output path for trim/remux/extract/remove operations.",
    }),
  ),
  start: Type.Optional(
    Type.String({
      description:
        "Trim start timestamp, e.g. 00:01:20. Required for mode=trim.",
    }),
  ),
  end: Type.Optional(
    Type.String({
      description: "Trim end timestamp, e.g. 00:24:00. Required for mode=trim.",
    }),
  ),
  container: Type.Optional(
    StringEnum(LOSSLESS_OUTPUT_CONTAINERS, {
      description: "Output container used when output is omitted.",
    }),
  ),
  dryRun: Type.Optional(
    Type.Boolean({
      description: "Preview command without executing. Defaults to true.",
    }),
  ),
  replaceOutput: Type.Optional(
    Type.Boolean({
      description: "Allow overwriting the output path. Defaults to false.",
    }),
  ),
});

type DownloadParams = Static<typeof DownloadParamsSchema>;
type TranscodeParams = Static<typeof TranscodeParamsSchema>;
type LosslessEditParams = Static<typeof LosslessEditParamsSchema>;
type DownloadMode = NonNullable<DownloadParams["mode"]>;
type AudioFormat = NonNullable<DownloadParams["audioFormat"]>;
type VideoContainer = NonNullable<DownloadParams["videoContainer"]>;
type PlaylistMode = NonNullable<DownloadParams["playlistMode"]>;
type OverwriteMode = NonNullable<DownloadParams["overwriteMode"]>;
type CookieBrowser = NonNullable<DownloadParams["cookiesFromBrowser"]>;
type DownloadCompatibilityProfile = NonNullable<
  DownloadParams["compatibilityProfile"]
>;
type TranscodeEngine = NonNullable<TranscodeParams["engine"]>;
type TranscodeAudioMode = NonNullable<TranscodeParams["audioMode"]>;
type TranscodeOutputNaming = NonNullable<TranscodeParams["outputNaming"]>;
type TranscodeVideoCodec = NonNullable<TranscodeParams["videoCodec"]>;
type TranscodeProfile = NonNullable<TranscodeParams["profile"]>;
type LosslessEditMode = NonNullable<LosslessEditParams["mode"]>;
type LosslessEditEngine = NonNullable<LosslessEditParams["engine"]>;
type LosslessOutputContainer = NonNullable<LosslessEditParams["container"]>;

type PickerUI = {
  select(title: string, options: string[]): Promise<string | undefined>;
};

interface DownloadJob {
  label: string;
  urls: string[];
  args: string[];
}

interface DownloadJobResult {
  label: string;
  urlCount: number;
  commandPreview: string;
  code: number;
  stdout: string;
  stderr: string;
}

interface TranscodePlanItem {
  command: "ffmpeg" | "HandBrakeCLI";
  inputPath: string;
  finalPath: string;
  tempPath: string;
  audioCodec?: string;
  audioAction: "copy" | "aac" | "none";
  handbrakePreset?: string;
  args: string[];
}

interface TranscodeResult {
  command: "ffmpeg" | "HandBrakeCLI";
  inputPath: string;
  finalPath: string;
  tempPath: string;
  audioCodec?: string;
  audioAction: "copy" | "aac" | "none";
  handbrakePreset?: string;
  commandPreview: string;
  code: number;
  status: "dry-run" | "success" | "failed" | "skipped";
  error?: string;
  stderr?: string;
  stdout?: string;
}

interface DateExtractionRule {
  domain: string;
  source: "html" | "url";
  pattern: string;
}

interface RulesFile {
  version: 1;
  rules: DateExtractionRule[];
}

interface RuleMatchCandidate {
  label: string;
  pattern: string;
  source: "html" | "url";
  value: string;
}

interface MediaDiscoveryRule {
  name: string;
  domain: string;
  urlPattern: string;
  entryPattern: string;
  fields: Record<string, string>;
}

interface DiscoveryRulesFile {
  version: 1;
  rules: MediaDiscoveryRule[];
}

interface MediaPreviewCandidate {
  index: number;
  url: string;
  webpageUrl: string;
  mediaUrl?: string;
  title: string;
  displayName: string;
  description: string;
  availability: string;
  date: string;
  durationSeconds?: number;
  duration: string;
  thumbnail?: string;
  series?: string;
  season?: string;
  episode?: string;
  episodeNumber?: number;
  playlistIndex?: number;
  extractor: string;
  inputUrl: string;
}

interface MediaPreviewJob {
  url: string;
  candidates: MediaPreviewCandidate[];
  detail: string;
  code: number;
  stdout: string;
  stderr: string;
}

const RULES_FILE_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "extensions",
  "yt-dlp-ffmpeg.rules.json",
);
const DISCOVERY_RULES_FILE_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "extensions",
  "yt-dlp-ffmpeg.discovery-rules.json",
);

function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandPreview(command: string, args: string[]): string {
  return [command, ...args.map(shellQuote)].join(" ");
}

function dedupeUrls(urls: string[]): string[] {
  const unique = new Set<string>();
  const result: string[] = [];
  for (const url of urls) {
    const trimmed = url.trim();
    if (!trimmed || unique.has(trimmed)) continue;
    unique.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function isLikelyPlaylistUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.searchParams.has("list")) return true;
    const pathname = parsed.pathname.toLowerCase();
    return pathname.includes("/playlist") || pathname.includes("/sets/");
  } catch {
    return false;
  }
}

// BBC programme IDs ("pids") are 8+ lowercase alphanumerics starting with b/m/p/w.
const BBC_PID_PATTERN = /^[bmpw][0-9a-z]{7,}$/i;

// BBC Sounds paths that carry a programme pid: an episode, or a whole series.
const BBC_SOUNDS_PID_PATHS = new Set(["play", "brand", "series"]);

// Matches the bare /programmes/<pid> and /sounds/play/<pid> shapes. These usually
// address one item, but a brand or series page is spelled identically, so callers
// must classify with fetchBbcProgrammeKind before treating one as a single item.
function isBbcProgrammePermalinkUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (!parsed.hostname.toLowerCase().endsWith("bbc.co.uk")) return false;
    const segments = parsed.pathname
      .toLowerCase()
      .split("/")
      .filter(Boolean);
    if (segments.length === 2 && segments[0] === "programmes")
      return BBC_PID_PATTERN.test(segments[1]);
    // yt-dlp fails on every /sounds/ form; all of them are rewritten to the
    // equivalent /programmes/ URL, which its BBC extractor does handle.
    if (
      segments.length === 3 &&
      segments[0] === "sounds" &&
      BBC_SOUNDS_PID_PATHS.has(segments[1])
    )
      return BBC_PID_PATTERN.test(segments[2]);
    return false;
  } catch {
    return false;
  }
}

function bbcPidFromUrl(rawUrl: string): string | undefined {
  try {
    const segments = new URL(rawUrl).pathname.split("/").filter(Boolean);
    const pid = segments[segments.length - 1];
    return pid && BBC_PID_PATTERN.test(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

// yt-dlp's BBC extractor resolves /programmes/<pid> but fails on the Sounds
// player URL for that same pid ("Unable to extract playlist data"), so every
// permalink is addressed as a programme.
function bbcProgrammeUrl(rawUrl: string): string | undefined {
  const pid = bbcPidFromUrl(rawUrl);
  return pid ? `https://www.bbc.co.uk/programmes/${pid}` : undefined;
}

function bbcEpisodeIndexUrl(rawUrl: string): string | undefined {
  const pid = bbcPidFromUrl(rawUrl);
  return pid
    ? `https://www.bbc.co.uk/programmes/${pid}/episodes/player`
    : undefined;
}

function isGenericMediaCollectionUrl(rawUrl: string): boolean {
  try {
    // "programmes" is a collection marker below, which would otherwise make every
    // single-episode permalink look like a list and trigger the entry picker.
    if (isBbcProgrammePermalinkUrl(rawUrl)) return false;
    const parsed = new URL(rawUrl);
    const pathname = parsed.pathname.toLowerCase();
    const segments = pathname.split("/").filter(Boolean);
    if (parsed.searchParams.has("list")) return true;
    if (["page", "offset", "start"].some((key) => parsed.searchParams.has(key)))
      return true;
    if (segments.length === 0) return false;
    if (/\.(?:atom|json|rss|xml)$/i.test(segments[segments.length - 1])) {
      return true;
    }
    const markers = new Set([
      "archive",
      "archives",
      "atom",
      "audios",
      "collection",
      "collections",
      "episodes",
      "feed",
      "feeds",
      "podcast",
      "podcasts",
      "programmes",
      "rss",
      "series",
      "sets",
      "shows",
      "videos",
    ]);
    const last = segments[segments.length - 1];
    if (markers.has(last)) return true;
    const markerIndex = segments.findIndex((segment) => markers.has(segment));
    if (markerIndex < 0 || segments.length - markerIndex > 2) return false;
    return (
      !/^\d+$/.test(last) &&
      !/^(episode|episodes|item|track|video)-?\d+$/i.test(last)
    );
  } catch {
    return false;
  }
}

function isBbcEpisodeListUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return (
      isBbcProgrammesUrl(rawUrl) &&
      parsed.pathname.toLowerCase().includes("/episodes/")
    );
  } catch {
    return false;
  }
}

function isRtveSeriesUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return (
      parsed.hostname.toLowerCase().endsWith("rtve.es") &&
      /^\/play\/audios\/[^/]+\/?$/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function isMediaPlaylistUrl(rawUrl: string): boolean {
  return (
    isLikelyPlaylistUrl(rawUrl) ||
    isGenericMediaCollectionUrl(rawUrl) ||
    isBbcEpisodeListUrl(rawUrl) ||
    isRtveSeriesUrl(rawUrl)
  );
}

function isYoutubeUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return (
      hostname === "youtube.com" ||
      hostname.endsWith(".youtube.com") ||
      hostname === "youtu.be" ||
      hostname.endsWith(".youtu.be")
    );
  } catch {
    return false;
  }
}

function isBbcProgrammesUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    return (
      hostname.endsWith("bbc.co.uk") &&
      (pathname.includes("/programmes/") || pathname.includes("/sounds/play/"))
    );
  } catch {
    return false;
  }
}

function isRtveAudioUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    return hostname.endsWith("rtve.es") && pathname.includes("/play/audios/");
  } catch {
    return false;
  }
}

function normalizeIsoDate(date: string): string | undefined {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return undefined;
  return `${match[1]}.${match[2]}.${match[3]}`;
}

function normalizeSlashDate(date: string): string | undefined {
  const match = date.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return undefined;
  return `${match[3]}.${match[2]}.${match[1]}`;
}

function extractDateFromSegment(segment: string): string | undefined {
  const contentMatch = segment.match(/content="(\d{4}-\d{2}-\d{2})T[^"]*"/i);
  if (contentMatch) {
    const formatted = normalizeIsoDate(contentMatch[1]);
    if (formatted) return formatted;
  }
  const titleMatch = segment.match(
    /title="(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})"/i,
  );
  if (!titleMatch) return undefined;
  const monthMap: Record<string, string> = {
    january: "01",
    february: "02",
    march: "03",
    april: "04",
    may: "05",
    june: "06",
    july: "07",
    august: "08",
    september: "09",
    october: "10",
    november: "11",
    december: "12",
  };
  const month = monthMap[titleMatch[2].toLowerCase()];
  if (!month) return undefined;
  const day = titleMatch[1].padStart(2, "0");
  return `${titleMatch[3]}.${month}.${day}`;
}

function extractBbcBroadcastDate(html: string): string | undefined {
  // JSON-LD datePublished is the original broadcast date and agrees with BBC's
  // own first_broadcast_date. Prefer it: the "Last on" block below reports the
  // most recent repeat, and the bare datetime scan after it can land on an
  // availability expiry, either of which misdates the file by weeks.
  const published = /"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})/.exec(html);
  if (published) {
    const normalized = normalizeIsoDate(published[1]);
    if (normalized) return normalized;
  }
  const lastOnBlockMatch = html.match(
    /<h2>\s*Last on\s*<\/h2>[\s\S]{0,12000}/i,
  );
  if (lastOnBlockMatch) {
    const inLastOn = extractDateFromSegment(lastOnBlockMatch[0]);
    if (inLastOn) return inLastOn;
  }
  const firstDatetime = extractDateFromSegment(html);
  if (firstDatetime) return firstDatetime;
  return undefined;
}

function extractRtveEmissionDateFromUrl(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\/(\d{2})-(\d{2})-(\d{2})\/?$/);
    if (!match) return undefined;
    const year = Number.parseInt(match[3], 10);
    const fullYear = year >= 70 ? 1900 + year : 2000 + year;
    return `${fullYear.toString().padStart(4, "0")}.${match[2]}.${match[1]}`;
  } catch {
    return undefined;
  }
}

function extractRtveEmissionDate(html: string): string | undefined {
  const emissionJsonMatch = html.match(/"emission":"(\d{2}\/\d{2}\/\d{4})"/i);
  if (emissionJsonMatch) {
    const normalized = normalizeSlashDate(emissionJsonMatch[1]);
    if (normalized) return normalized;
  }

  const datemiMatch = html.match(/class="datemi"[^>]*>(\d{2}\/\d{2}\/\d{4})</i);
  if (datemiMatch) {
    const normalized = normalizeSlashDate(datemiMatch[1]);
    if (normalized) return normalized;
  }

  const ariaLabelMatch = html.match(
    /Fecha de emisión:[^"]*(\d{2}\/\d{2}\/\d{4})/i,
  );
  if (ariaLabelMatch) {
    const normalized = normalizeSlashDate(ariaLabelMatch[1]);
    if (normalized) return normalized;
  }

  return undefined;
}

function monthNameToNumber(name: string): string | undefined {
  const monthMap: Record<string, string> = {
    january: "01",
    february: "02",
    march: "03",
    april: "04",
    may: "05",
    june: "06",
    july: "07",
    august: "08",
    september: "09",
    october: "10",
    november: "11",
    december: "12",
    enero: "01",
    febrero: "02",
    marzo: "03",
    abril: "04",
    mayo: "05",
    junio: "06",
    julio: "07",
    agosto: "08",
    septiembre: "09",
    octubre: "10",
    noviembre: "11",
    diciembre: "12",
  };
  return monthMap[name.toLowerCase()];
}

function normalizeDateCandidate(rawValue: string): string | undefined {
  const value = rawValue.trim();
  if (!value) return undefined;

  if (/^\d{4}\.\d{2}\.\d{2}$/.test(value)) {
    return value;
  }

  const isoDirect = normalizeIsoDate(value);
  if (isoDirect) return isoDirect;

  const slash = normalizeSlashDate(value);
  if (slash) return slash;

  const isoTimeMatch = value.match(/^(\d{4}-\d{2}-\d{2})T/);
  if (isoTimeMatch) {
    const normalized = normalizeIsoDate(isoTimeMatch[1]);
    if (normalized) return normalized;
  }

  const dashDayMonthYear = value.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (dashDayMonthYear) {
    return `${dashDayMonthYear[3]}.${dashDayMonthYear[2]}.${dashDayMonthYear[1]}`;
  }

  const dayMonthYearShort = value.match(/^(\d{2})-(\d{2})-(\d{2})$/);
  if (dayMonthYearShort) {
    const year = Number.parseInt(dayMonthYearShort[3], 10);
    const fullYear = year >= 70 ? 1900 + year : 2000 + year;
    return `${fullYear.toString().padStart(4, "0")}.${dayMonthYearShort[2]}.${dayMonthYearShort[1]}`;
  }

  const monthNamePattern = value.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (monthNamePattern) {
    const month = monthNameToNumber(monthNamePattern[1]);
    if (month) {
      return `${monthNamePattern[3]}.${month}.${monthNamePattern[2].padStart(2, "0")}`;
    }
  }

  const dayMonthNamePattern = value.match(
    /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/,
  );
  if (dayMonthNamePattern) {
    const month = monthNameToNumber(dayMonthNamePattern[2]);
    if (month) {
      return `${dayMonthNamePattern[3]}.${month}.${dayMonthNamePattern[1].padStart(2, "0")}`;
    }
  }

  return undefined;
}

function decodeHtmlEntities(value: string): string {
  return String(value || "")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, code: string) => {
      const number = Number(code);
      return Number.isSafeInteger(number) && number <= 0x10ffff
        ? String.fromCodePoint(number)
        : _match;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => {
      const number = Number.parseInt(code, 16);
      return Number.isSafeInteger(number) && number <= 0x10ffff
        ? String.fromCodePoint(number)
        : _match;
    });
}

function stripMarkup(value: string): string {
  return decodeHtmlEntities(String(value || ""))
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveMediaUrl(value: unknown, sourceUrl: string): string {
  const raw = decodeHtmlEntities(String(value || "").trim());
  if (!raw) return "";
  try {
    const parsed = new URL(raw, sourceUrl);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : "";
  } catch {
    return "";
  }
}

function parseFlexibleMediaDuration(value: unknown): number | undefined {
  const raw = stripMarkup(String(value || ""));
  if (!raw) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  const iso = raw.match(
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i,
  );
  if (iso) {
    return (
      Number(iso[1] || 0) * 86400 +
      Number(iso[2] || 0) * 3600 +
      Number(iso[3] || 0) * 60 +
      Number(iso[4] || 0)
    );
  }
  const parts = raw.split(":").map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isInteger(part) || part < 0))
    return undefined;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return undefined;
}

function formatMediaDuration(value: unknown): string {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${remaining.toString().padStart(2, "0")}`
    : `${minutes}:${remaining.toString().padStart(2, "0")}`;
}

function formatMediaDate(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d{8}$/.test(raw))
    return `${raw.slice(0, 4)}.${raw.slice(4, 6)}.${raw.slice(6, 8)}`;
  return normalizeDateCandidate(raw) || raw.slice(0, 40);
}

function extractElementText(block: string, names: string[]): string {
  for (const name of names) {
    const match = new RegExp(
      `<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`,
      "i",
    ).exec(block);
    if (match) return stripMarkup(match[1]);
  }
  return "";
}

function extractElementAttribute(
  block: string,
  names: string[],
  attribute: string,
): string {
  for (const name of names) {
    const match = new RegExp(
      `<${name}\\b[^>]*\\b${attribute}\\s*=\\s*(["'])([\\s\\S]*?)\\1`,
      "i",
    ).exec(block);
    if (match) return decodeHtmlEntities(match[2]);
  }
  return "";
}

function inferMediaTitle(context: string, fallbackUrl: string): string {
  const heading = /<(?:h[1-6]|strong|b)\b[^>]*>([\s\S]*?)<\/[^>]+>/i.exec(
    context,
  );
  if (heading) {
    const title = stripMarkup(heading[1]);
    if (title) return title.slice(0, 500);
  }
  const labelled = /(?:aria-label|title)=["']([^"']+)["']/i.exec(context);
  if (labelled) return decodeHtmlEntities(labelled[1]).trim().slice(0, 500);
  try {
    return decodeURIComponent(
      new URL(fallbackUrl).pathname.split("/").filter(Boolean).pop() || "",
    )
      .replace(/[-_]+/g, " ")
      .replace(/\.[A-Za-z0-9]{2,5}$/, "")
      .trim()
      .slice(0, 500);
  } catch {
    return "";
  }
}

function isMediaFileUrl(url: string): boolean {
  return /\.(?:aac|m4a|m3u8|m4v|mp3|mp4|mpd|ogg|opus|wav|webm)(?:$|[?#])/i.test(
    url,
  );
}

// Chrome/navigation links that the keyword test below would otherwise wave through.
const NAV_ONLY_PATH_SEGMENTS = new Set([
  "about",
  "accessibility",
  "audios",
  "categories",
  "contact",
  "contacts",
  "episodes",
  "help",
  "podcasts",
  "privacy",
  "programmes",
  "register",
  "schedules",
  "search",
  "series",
  "shows",
  "sign-in",
  "signin",
  "terms",
  "videos",
]);

function isPlausibleMediaEntryUrl(url: string, sourceUrl: string): boolean {
  try {
    const candidate = new URL(url);
    const source = new URL(sourceUrl);
    if (candidate.protocol !== "http:" && candidate.protocol !== "https:")
      return false;
    if (candidate.origin !== source.origin || candidate.href === source.href)
      return false;
    // In-page anchors ("Skip to content") resolve to the source page plus a
    // fragment, so href alone does not catch them.
    if (
      candidate.pathname === source.pathname &&
      candidate.search === source.search
    )
      return false;
    const pathname = candidate.pathname.toLowerCase();
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length === 0) return false;
    if (NAV_ONLY_PATH_SEGMENTS.has(segments[segments.length - 1])) return false;
    return (
      /(?:episode|podcast|audio|video|programme|program|listen|watch|media|track|item|story|show|series)/i.test(
        pathname,
      ) || /\d{4,}/.test(pathname)
    );
  } catch {
    return false;
  }
}

function parseJsonLdBlock(value: string): unknown {
  for (const candidate of [value, decodeHtmlEntities(value)]) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }
  }
  return null;
}

function collectJsonLdMediaItems(
  value: unknown,
  output: Record<string, unknown>[],
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonLdMediaItems(item, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, any>;
  if (Array.isArray(object.itemListElement)) {
    for (const listed of object.itemListElement) {
      const item = listed?.item || listed;
      if (item && typeof item === "object")
        output.push(item as Record<string, unknown>);
    }
  }
  const types = Array.isArray(object["@type"])
    ? object["@type"]
    : [object["@type"]];
  const mediaTypes = new Set([
    "AudioObject",
    "Episode",
    "MusicRecording",
    "PodcastEpisode",
    "VideoObject",
  ]);
  if (
    types.some((type: unknown) => mediaTypes.has(String(type))) &&
    (object.url || object.contentUrl || object.enclosure)
  ) {
    output.push(object);
  }
  if (object["@graph"]) collectJsonLdMediaItems(object["@graph"], output);
}

function structuredMediaCandidate(
  item: Record<string, any>,
  sourceUrl: string,
  index: number,
  extractor: string,
): Record<string, unknown> | undefined {
  const encoding = Array.isArray(item.encoding)
    ? item.encoding[0]
    : item.encoding;
  const associatedMedia = item.associatedMedia || {};
  const offers = item.offers || {};
  const directUrl = resolveMediaUrl(
    item.contentUrl ||
      item.mediaUrl ||
      item.file ||
      item.enclosure?.url ||
      encoding?.contentUrl ||
      associatedMedia.contentUrl,
    sourceUrl,
  );
  const webpageUrl = resolveMediaUrl(
    item.url || item.sameAs || item.mainEntityOfPage,
    sourceUrl,
  );
  const stableUrl = webpageUrl || directUrl;
  if (!stableUrl) return undefined;
  const image = Array.isArray(item.image) ? item.image[0] : item.image;
  const thumbnail =
    typeof item.thumbnailUrl === "string"
      ? item.thumbnailUrl
      : typeof image === "string"
        ? image
        : image?.url;
  return {
    id: String(item.identifier || item.id || "").trim(),
    title: String(item.name || item.title || item.headline || "")
      .trim()
      .slice(0, 500),
    description: stripMarkup(String(item.description || "")).slice(0, 1000),
    webpage_url: stableUrl,
    original_url: stableUrl,
    direct_url: directUrl,
    duration: parseFlexibleMediaDuration(item.duration),
    release_date: normalizeDateCandidate(
      String(item.datePublished || item.uploadDate || item.dateCreated || ""),
    ),
    thumbnail: resolveMediaUrl(thumbnail, sourceUrl),
    availability: String(
      item.availability ||
        offers.availability ||
        (directUrl ? "Available" : ""),
    ).trim(),
    playlist_index: index,
    extractor,
  };
}

function extractGenericHtmlEntries(
  html: string,
  sourceUrl: string,
): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const append = (candidate: Record<string, unknown> | undefined): void => {
    if (!candidate) return;
    const key = String(
      candidate.id || candidate.webpage_url || candidate.direct_url || "",
    );
    if (!key || seen.has(key)) return;
    seen.add(key);
    candidate.playlist_index = entries.length + 1;
    entries.push(candidate);
  };
  const jsonItems: Record<string, unknown>[] = [];
  const scriptPattern =
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptPattern)) {
    const parsed = parseJsonLdBlock(match[1]);
    if (parsed) collectJsonLdMediaItems(parsed, jsonItems);
  }
  for (const item of jsonItems)
    append(
      structuredMediaCandidate(
        item as Record<string, any>,
        sourceUrl,
        entries.length + 1,
        "generic:json-ld",
      ),
    );

  const itemPattern = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of html.matchAll(itemPattern)) {
    const block = match[2];
    const directUrl = resolveMediaUrl(
      extractElementAttribute(
        block,
        ["enclosure", "media:content", "content"],
        "url",
      ),
      sourceUrl,
    );
    const webpageUrl = resolveMediaUrl(
      extractElementAttribute(block, ["link"], "href") ||
        extractElementText(block, ["link", "guid"]),
      sourceUrl,
    );
    const stableUrl = webpageUrl || directUrl;
    if (!stableUrl) continue;
    append({
      id: extractElementText(block, ["guid", "id"]),
      title: extractElementText(block, ["title"]).slice(0, 500),
      description: extractElementText(block, ["description", "summary"]).slice(
        0,
        1000,
      ),
      webpage_url: stableUrl,
      original_url: stableUrl,
      direct_url: directUrl,
      duration: parseFlexibleMediaDuration(
        extractElementText(block, ["itunes:duration", "duration"]),
      ),
      release_date: normalizeDateCandidate(
        extractElementText(block, ["pubDate", "published", "updated", "date"]),
      ),
      thumbnail: resolveMediaUrl(
        extractElementAttribute(
          block,
          ["itunes:image", "media:thumbnail"],
          "href",
        ) ||
          extractElementAttribute(
            block,
            ["itunes:image", "media:thumbnail"],
            "url",
          ),
        sourceUrl,
      ),
      availability: directUrl ? "Available" : "Unknown",
      extractor: "generic:rss",
    });
  }

  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    const hrefMatch = /\bhref\s*=\s*(["'])([\s\S]*?)\1/i.exec(match[1]);
    if (!hrefMatch) continue;
    const url = resolveMediaUrl(hrefMatch[2], sourceUrl);
    if (!url) continue;
    const text = stripMarkup(match[2]);
    const titleMatch = /(?:aria-label|title)=["']([^"']+)["']/i.exec(match[1]);
    const title =
      text || (titleMatch ? decodeHtmlEntities(titleMatch[1]).trim() : "");
    if (isMediaFileUrl(url)) {
      append({
        title: title || inferMediaTitle(match[0], url),
        webpage_url: url,
        original_url: url,
        direct_url: url,
        availability: "Available",
        extractor: "generic:html",
      });
    } else if (title && isPlausibleMediaEntryUrl(url, sourceUrl)) {
      append({
        title: title.slice(0, 500),
        webpage_url: url,
        original_url: url,
        availability: "Unknown",
        extractor: "generic:html",
      });
    }
  }

  const mediaUrlPattern = /https?:\/\/[^"'<>\s]+/gi;
  for (const match of html.matchAll(mediaUrlPattern)) {
    const url = resolveMediaUrl(match[0].replace(/[),.;]+$/, ""), sourceUrl);
    if (!isMediaFileUrl(url)) continue;
    const start = Math.max(0, (match.index ?? 0) - 1000);
    const end = Math.min(
      html.length,
      (match.index ?? 0) + match[0].length + 1000,
    );
    append({
      title: inferMediaTitle(html.slice(start, end), url),
      webpage_url: url,
      original_url: url,
      direct_url: url,
      availability: "Available",
      extractor: "generic:html",
    });
  }
  return entries;
}

function normalizeDiscoveryRule(raw: unknown): MediaDiscoveryRule | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const object = raw as Record<string, any>;
  const domain = String(object.domain || "")
    .trim()
    .toLowerCase();
  const name = String(object.name || domain || "").trim();
  const entryPattern = String(object.entryPattern || "").trim();
  if (
    !domain ||
    !name ||
    !entryPattern ||
    entryPattern.length > DISCOVERY_RULE_MAX_PATTERN_LENGTH
  )
    return undefined;
  const fields: Record<string, string> = {};
  if (object.fields && typeof object.fields === "object") {
    for (const [field, value] of Object.entries(object.fields)) {
      if (!DISCOVERY_RULE_FIELDS.has(field)) continue;
      const pattern =
        typeof value === "string"
          ? value.trim()
          : String((value as any)?.pattern || "").trim();
      if (pattern && pattern.length <= DISCOVERY_RULE_MAX_PATTERN_LENGTH)
        fields[field] = pattern;
    }
  }
  if (
    !fields.url &&
    !fields.webpageUrl &&
    !fields.link &&
    !fields.mediaUrl &&
    !fields.file
  )
    return undefined;
  return {
    name,
    domain,
    urlPattern: String(object.urlPattern || "")
      .trim()
      .slice(0, 1000),
    entryPattern,
    fields,
  };
}

async function loadDiscoveryRules(): Promise<DiscoveryRulesFile> {
  try {
    const parsed = JSON.parse(
      await readFile(DISCOVERY_RULES_FILE_PATH, "utf8"),
    ) as Partial<DiscoveryRulesFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.rules))
      return { version: 1, rules: [] };
    return {
      version: 1,
      rules: parsed.rules
        .map(normalizeDiscoveryRule)
        .filter((rule): rule is MediaDiscoveryRule => Boolean(rule)),
    };
  } catch {
    return { version: 1, rules: [] };
  }
}

async function saveDiscoveryRules(rules: MediaDiscoveryRule[]): Promise<void> {
  await mkdir(dirname(DISCOVERY_RULES_FILE_PATH), { recursive: true });
  await writeFile(
    DISCOVERY_RULES_FILE_PATH,
    `${JSON.stringify({ version: 1, rules }, null, 2)}\n`,
    "utf8",
  );
}

function discoveryRuleMatchesUrl(
  url: string,
  rule: MediaDiscoveryRule,
): boolean {
  if (!matchesDomain(url, rule.domain)) return false;
  if (!rule.urlPattern) return true;
  if (rule.urlPattern.startsWith("re:")) {
    try {
      return new RegExp(rule.urlPattern.slice(3), "i").test(url);
    } catch {
      return false;
    }
  }
  return url.toLowerCase().includes(rule.urlPattern.toLowerCase());
}

function extractDiscoveryPattern(
  text: string,
  pattern: string | undefined,
): string {
  if (!pattern) return "";
  try {
    const match = new RegExp(pattern, "i").exec(text);
    return match ? decodeHtmlEntities(match[1] ?? match[0]) : "";
  } catch {
    return "";
  }
}

function extractConfiguredMediaEntries(
  html: string,
  sourceUrl: string,
  rules: MediaDiscoveryRule[],
  maxEntries: number,
): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    if (!discoveryRuleMatchesUrl(sourceUrl, rule)) continue;
    let entryRegex: RegExp;
    try {
      entryRegex = new RegExp(rule.entryPattern, "gi");
    } catch {
      continue;
    }
    for (const match of html.matchAll(entryRegex)) {
      if (entries.length >= Math.min(DISCOVERY_RULE_MAX_ENTRIES, maxEntries))
        return entries;
      const block = match[1] || match[0];
      const field = (name: string) =>
        extractDiscoveryPattern(block, rule.fields[name]);
      const webpageUrl = resolveMediaUrl(
        field("url") || field("webpageUrl") || field("link"),
        sourceUrl,
      );
      const directUrl = resolveMediaUrl(
        field("mediaUrl") || field("file"),
        sourceUrl,
      );
      const stableUrl = webpageUrl || directUrl;
      if (!stableUrl || seen.has(stableUrl)) continue;
      seen.add(stableUrl);
      entries.push({
        id: field("id"),
        title: stripMarkup(field("title")) || inferMediaTitle(block, stableUrl),
        description: stripMarkup(field("description")).slice(0, 1000),
        webpage_url: stableUrl,
        original_url: stableUrl,
        direct_url: directUrl,
        duration: parseFlexibleMediaDuration(field("duration")),
        release_date: normalizeDateCandidate(field("date")),
        thumbnail: resolveMediaUrl(field("thumbnail"), sourceUrl),
        availability: directUrl ? "Available" : "Unknown",
        extractor: `rule:${rule.name}`,
      });
    }
  }
  return entries;
}

function appendYtDlpCookieArgs(
  args: string[],
  options: Partial<DownloadParams>,
): void {
  if (options.cookiesFile?.trim())
    args.push("--cookies", options.cookiesFile.trim());
  else if (
    options.cookiesFromBrowser &&
    options.cookiesFromBrowser !== "none"
  ) {
    args.push(
      "--cookies-from-browser",
      options.cookiesProfile?.trim()
        ? `${options.cookiesFromBrowser}:${options.cookiesProfile.trim()}`
        : options.cookiesFromBrowser,
    );
  }
}

async function runYtDlpJson(
  pi: ExtensionAPI,
  cwd: string,
  url: string,
  options: Partial<DownloadParams>,
  signal: AbortSignal | undefined,
  playlist = false,
  maxEntries?: number,
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  data: Record<string, any> | null;
}> {
  const args = [
    "--dump-single-json",
    "--no-warnings",
    "--skip-download",
    "--ignore-no-formats",
  ];
  if (playlist) {
    args.push("--flat-playlist");
    // -I supersedes --playlist-end, which is now an undocumented legacy alias.
    if (maxEntries && maxEntries > 0) args.push("-I", `:${maxEntries}`);
  } else args.push("--no-playlist");
  appendYtDlpCookieArgs(args, options);
  args.push(url);
  const result = await pi.exec("yt-dlp", args, { signal, cwd });
  let data: Record<string, any> | null = null;
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed && typeof parsed === "object") {
        data = parsed;
        break;
      }
    } catch {
      continue;
    }
  }
  return { ...result, data };
}

async function fetchMediaPageHtml(
  pi: ExtensionAPI,
  cwd: string,
  url: string,
  signal: AbortSignal | undefined,
  options: Partial<DownloadParams>,
): Promise<string> {
  const args = ["-sL", "--max-time", "30", "-A", "Mozilla/5.0"];
  if (options.cookiesFile?.trim())
    args.push("--cookie", options.cookiesFile.trim());
  args.push(url);
  const result = await pi.exec("curl", args, { signal, cwd });
  return result.code === 0 && result.stdout.trim() ? result.stdout : "";
}

// BBC serves a small JSON descriptor beside every programme page, and it names
// the programme type, which the URL itself cannot: /programmes/<pid> is equally
// the shape of one episode and of a whole brand.
async function fetchBbcProgrammeKind(
  pi: ExtensionAPI,
  cwd: string,
  url: string,
  signal: AbortSignal | undefined,
): Promise<"episode" | "collection" | undefined> {
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    const pid = segments[segments.length - 1];
    if (!pid || !BBC_PID_PATTERN.test(pid)) return undefined;
    const result = await pi.exec(
      "curl",
      [
        "-sL",
        "--max-time",
        "15",
        "-A",
        "Mozilla/5.0",
        `https://www.bbc.co.uk/programmes/${pid}.json`,
      ],
      { signal, cwd },
    );
    if (result.code !== 0 || !result.stdout.trim()) return undefined;
    const payload = JSON.parse(result.stdout) as {
      programme?: { type?: unknown };
    };
    const type = String(payload?.programme?.type ?? "").toLowerCase();
    if (type === "episode" || type === "clip") return "episode";
    if (type === "brand" || type === "series") return "collection";
    return undefined;
  } catch {
    return undefined;
  }
}

// Swap brand/series permalinks for their episode index so yt-dlp can enumerate
// them. Episode permalinks, and anything that will not classify, are left alone.
async function resolveBbcProgrammeUrls(
  pi: ExtensionAPI,
  cwd: string,
  urls: string[],
  signal: AbortSignal | undefined,
  onUpdate?: (text: string) => void,
): Promise<string[]> {
  if (!urls.some(isBbcProgrammePermalinkUrl)) return urls;
  let expanded = 0;
  let rewritten = 0;
  const resolved = await Promise.all(
    urls.map(async (url) => {
      if (!isBbcProgrammePermalinkUrl(url)) return url;
      const kind = await fetchBbcProgrammeKind(pi, cwd, url, signal);
      // No descriptor means no /programmes/ page for this pid — Sounds carries
      // podcast-only content that lives nowhere else. Leave those alone rather
      // than rewriting them to a URL that does not exist, so the user sees
      // yt-dlp's error about the link they actually gave.
      if (!kind) return url;
      const target =
        kind === "collection" ? bbcEpisodeIndexUrl(url) : bbcProgrammeUrl(url);
      if (!target || target === url) return url;
      if (kind === "collection") expanded += 1;
      else rewritten += 1;
      return target;
    }),
  );
  const notes: string[] = [];
  if (expanded > 0)
    notes.push(
      `expanded ${expanded} BBC ${
        expanded === 1 ? "index" : "indexes"
      } into episode lists`,
    );
  if (rewritten > 0)
    notes.push(
      rewritten === 1
        ? "rewrote 1 BBC Sounds link to its programme page"
        : `rewrote ${rewritten} BBC Sounds links to their programme pages`,
    );
  if (notes.length > 0)
    onUpdate?.(notes.join("; ").replace(/^./, (c) => c.toUpperCase()));
  return dedupeUrls(resolved);
}

async function discoverGenericMediaEntries(
  pi: ExtensionAPI,
  cwd: string,
  url: string,
  signal: AbortSignal | undefined,
  options: Partial<DownloadParams>,
  rules: MediaDiscoveryRule[],
  maxEntries: number,
): Promise<{ entries: Record<string, unknown>[]; detail: string }> {
  const html = await fetchMediaPageHtml(pi, cwd, url, signal, options);
  if (!html)
    return {
      entries: [],
      detail: "Could not fetch the page for generic media discovery",
    };
  const configured = extractConfiguredMediaEntries(
    html,
    url,
    rules,
    maxEntries,
  );
  const entries = configured.length
    ? configured
    : extractGenericHtmlEntries(html, url).slice(0, maxEntries);
  return {
    entries,
    detail: entries.length
      ? ""
      : "No structured media entries were found in the page HTML",
  };
}

// Same episode, different spelling: index pages hand out http:// links while a
// direct resolution reports https://. Compare on host + path so both collapse.
function mediaDedupeKey(value: string): string {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/+$/, "").toLowerCase();
    return `${host}${path}${parsed.search}`;
  } catch {
    return value.trim().toLowerCase();
  }
}

function normalizeMediaCandidate(
  raw: Record<string, unknown>,
  inputUrl: string,
  index: number,
): MediaPreviewCandidate {
  const webpageUrl = resolveMediaUrl(
    raw.webpage_url || raw.original_url || raw.url,
    inputUrl,
  );
  const mediaUrl = resolveMediaUrl(
    raw.direct_url || raw.media_url || raw.file,
    inputUrl,
  );
  const durationSeconds = Number(raw.duration);
  const playlistIndex = Number(raw.playlist_index);
  const title = String(raw.title || raw.fulltitle || "").trim();
  return {
    index,
    url: webpageUrl,
    webpageUrl,
    mediaUrl: mediaUrl || undefined,
    title,
    displayName: title || `Media entry ${index}`,
    description: String(raw.description || "")
      .trim()
      .slice(0, 500),
    availability: String(
      raw.availability ||
        raw.live_status ||
        (webpageUrl ? "Available" : "Unavailable"),
    ).replace(/[_-]+/g, " "),
    date: formatMediaDate(
      raw.release_date ||
        raw.upload_date ||
        raw.release_timestamp ||
        raw.timestamp,
    ),
    durationSeconds:
      Number.isFinite(durationSeconds) && durationSeconds >= 0
        ? durationSeconds
        : undefined,
    duration: formatMediaDuration(durationSeconds),
    thumbnail: resolveMediaUrl(raw.thumbnail, inputUrl) || undefined,
    series: String(raw.series || "").trim() || undefined,
    season: String(raw.season || "").trim() || undefined,
    episode: String(raw.episode || "").trim() || undefined,
    episodeNumber: Number.isFinite(Number(raw.episode_number))
      ? Number(raw.episode_number)
      : undefined,
    playlistIndex: Number.isInteger(playlistIndex) ? playlistIndex : undefined,
    extractor: String(raw.extractor || "").trim(),
    inputUrl,
  };
}

async function hydrateMediaEntries(
  pi: ExtensionAPI,
  cwd: string,
  entries: Record<string, unknown>[],
  inputUrl: string,
  options: Partial<DownloadParams>,
  signal: AbortSignal | undefined,
): Promise<MediaPreviewCandidate[]> {
  const result = new Array<MediaPreviewCandidate>(entries.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= entries.length) return;
      let entry = entries[index];
      const entryUrl = resolveMediaUrl(
        entry.webpage_url || entry.original_url || entry.url,
        inputUrl,
      );
      const hasUseful = Boolean(
        String(entry.title || entry.fulltitle || "").trim() &&
        (entry.duration !== undefined ||
          entry.release_date ||
          entry.upload_date ||
          entry.thumbnail),
      );
      if (entryUrl && !hasUseful) {
        const detail = await runYtDlpJson(pi, cwd, entryUrl, options, signal);
        if (detail.data)
          entry = {
            ...entry,
            ...Object.fromEntries(
              Object.entries(detail.data).filter(
                ([, value]) =>
                  value !== undefined && value !== null && value !== "",
              ),
            ),
          };
      }
      result[index] = normalizeMediaCandidate(entry, inputUrl, index + 1);
    }
  };
  await Promise.all(
    Array.from(
      {
        length: Math.min(
          MEDIA_PREVIEW_METADATA_CONCURRENCY,
          Math.max(1, entries.length),
        ),
      },
      () => worker(),
    ),
  );
  return result;
}

// True when yt-dlp returned a single playable item rather than a list. Such a
// result already identifies exactly what to download, so no picker is needed.
function isResolvedSingleMedia(data: Record<string, any> | null): boolean {
  if (!data || typeof data !== "object") return false;
  if (data._type === "playlist" || data._type === "multi_video") return false;
  if (Array.isArray(data.entries)) return false;
  if (!data.id && !data.title) return false;
  return (
    (Array.isArray(data.formats) && data.formats.length > 0) ||
    typeof data.url === "string" ||
    Array.isArray(data.requested_downloads)
  );
}

async function discoverMediaPreview(
  pi: ExtensionAPI,
  cwd: string,
  urls: string[],
  options: Partial<DownloadParams>,
  signal: AbortSignal | undefined,
  onUpdate?: (text: string) => void,
): Promise<{
  jobs: MediaPreviewJob[];
  candidates: MediaPreviewCandidate[];
  warnings: string[];
}> {
  const rules = await loadDiscoveryRules();
  const maxEntries = Math.min(
    MEDIA_PREVIEW_MAX_ENTRIES,
    Math.max(1, options.maxPlaylistEntries ?? MEDIA_PREVIEW_MAX_ENTRIES),
  );
  const jobs: MediaPreviewJob[] = [];
  let remaining = maxEntries;
  for (const url of urls) {
    if (remaining <= 0) break;
    onUpdate?.(`Discovering media entries from ${url}`);
    const result = await runYtDlpJson(
      pi,
      cwd,
      url,
      options,
      signal,
      true,
      remaining,
    );
    let data = result.data;
    let entries: Record<string, unknown>[] = Array.isArray(data?.entries)
      ? data.entries.filter((entry): entry is Record<string, unknown> =>
          Boolean(entry && typeof entry === "object"),
        )
      : [];
    let detail = "";
    const hasRule = rules.rules.some((rule) =>
      discoveryRuleMatchesUrl(url, rule),
    );

    // A bare BBC brand/series permalink 404s in the extractor; its episode index
    // does not. Retry there instead of falling through to HTML scraping.
    if (
      entries.length === 0 &&
      !isResolvedSingleMedia(data) &&
      isBbcProgrammePermalinkUrl(url)
    ) {
      const indexUrl = bbcEpisodeIndexUrl(url);
      if (indexUrl && indexUrl !== url) {
        onUpdate?.(`Resolving ${url} as a programme index`);
        const retry = await runYtDlpJson(
          pi,
          cwd,
          indexUrl,
          options,
          signal,
          true,
          remaining,
        );
        const retryEntries = Array.isArray(retry.data?.entries)
          ? retry.data.entries.filter(
              (entry): entry is Record<string, unknown> =>
                Boolean(entry && typeof entry === "object"),
            )
          : [];
        if (retryEntries.length > 0) {
          data = retry.data;
          entries = retryEntries;
        }
      }
    }

    // yt-dlp resolved the URL to one concrete item. That answer is authoritative:
    // scraping the page here is what produced nav links like "Skip to content".
    if (entries.length === 0 && isResolvedSingleMedia(data)) {
      entries = [data as Record<string, unknown>];
    } else if (entries.length === 0 && isRtveSeriesUrl(url)) {
      const html = await fetchMediaPageHtml(pi, cwd, url, signal, options);
      entries = extractConfiguredMediaEntries(html, url, [], remaining);
      if (entries.length === 0) {
        const rtve = extractRtveSeriesEntries(html, url);
        entries = rtve;
      }
      detail = entries.length
        ? ""
        : "RTVE page contained no downloadable episode entries";
    } else if (
      entries.length === 0 &&
      (isGenericMediaCollectionUrl(url) || hasRule || options.preview === true)
    ) {
      const generic = await discoverGenericMediaEntries(
        pi,
        cwd,
        url,
        signal,
        options,
        rules.rules,
        remaining,
      );
      entries = generic.entries;
      detail = generic.detail;
    }
    if (entries.length === 0 && data && (data.id || data.title))
      entries = [data];
    if (entries.length === 0) {
      jobs.push({
        url,
        candidates: [],
        detail:
          detail ||
          result.stderr.trim().slice(0, 500) ||
          "yt-dlp returned no entries",
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      continue;
    }
    const selectedEntries = entries.slice(0, remaining);
    const candidates = await hydrateMediaEntries(
      pi,
      cwd,
      selectedEntries,
      url,
      options,
      signal,
    );
    jobs.push({
      url,
      candidates,
      detail,
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    remaining -= selectedEntries.length;
  }
  // Each job numbers its own candidates from 1, but the picker flattens every job
  // into one list and keys selection by candidate.index — so duplicate indexes
  // make unrelated entries toggle together. Renumber globally, and drop entries
  // already contributed by an earlier URL.
  const seenUrls = new Set<string>();
  const candidates: MediaPreviewCandidate[] = [];
  for (const job of jobs) {
    for (const candidate of job.candidates) {
      const rawKey =
        candidate.url || candidate.webpageUrl || candidate.mediaUrl;
      if (rawKey) {
        const key = mediaDedupeKey(rawKey);
        if (seenUrls.has(key)) continue;
        seenUrls.add(key);
      }
      const index = candidates.length + 1;
      candidates.push({
        ...candidate,
        index,
        displayName: candidate.title || `Media entry ${index}`,
      });
    }
  }
  const warnings = jobs
    .filter((job) => job.candidates.length === 0)
    .map((job) => `Preview failed for ${job.url}: ${job.detail}`);
  return { jobs, candidates, warnings };
}

function extractRtveSeriesEntries(
  html: string,
  sourceUrl: string,
): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const pattern =
    /<li\b[^>]*class=["']elem_["'][^>]*data-setup=(["'])(.*?)\1>([\s\S]*?)<\/li>/gi;
  for (const match of html.matchAll(pattern)) {
    let setup: Record<string, any> = {};
    try {
      const parsed = JSON.parse(decodeHtmlEntities(match[2]));
      if (parsed && typeof parsed === "object") setup = parsed;
    } catch {
      continue;
    }
    const block = match[3];
    const shareValue = /data-share=(["'])([\s\S]*?)\1/i.exec(block)?.[2] || "";
    let share: Record<string, any> = {};
    try {
      const parsed = JSON.parse(decodeHtmlEntities(shareValue));
      if (parsed && typeof parsed === "object") share = parsed;
    } catch {
      /* optional share metadata */
    }
    const href =
      /href=(["'])(https?:\/\/[^"']*rtve\.es\/play\/audios\/[^"']+)\1/i.exec(
        block,
      )?.[2] || "";
    const directUrl = resolveMediaUrl(share.file || share.url, sourceUrl);
    const stableUrl = resolveMediaUrl(href || directUrl, sourceUrl);
    const titleMatch =
      /class=["'][^"']*\bmaintitle\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i.exec(
        block,
      );
    const dateMatch =
      /class=["'][^"']*\bdatemi\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i.exec(
        block,
      );
    const durationMatch =
      /class=["'][^"']*\bduration\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i.exec(
        block,
      );
    if (!stableUrl) continue;
    const key = String(setup.idAsset || stableUrl);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      id: String(setup.idAsset || ""),
      title: String(
        setup.title || (titleMatch ? stripMarkup(titleMatch[1]) : ""),
      ).trim(),
      webpage_url: stableUrl,
      original_url: stableUrl,
      direct_url: directUrl,
      duration: parseFlexibleMediaDuration(
        durationMatch ? durationMatch[1] : "",
      ),
      release_date: normalizeDateCandidate(
        dateMatch ? stripMarkup(dateMatch[1]) : "",
      ),
      thumbnail: /\bsrc=["']([^"']+)["']/i.exec(block)?.[1] || "",
      availability: directUrl ? "Available" : "Unknown",
      extractor: "rtve.es:series",
    });
  }
  return entries;
}

function tryExtractWithRegex(
  sourceText: string,
  pattern: string,
): string | undefined {
  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern, "i");
  } catch {
    return undefined;
  }

  const match = compiled.exec(sourceText);
  if (!match) return undefined;
  const capture = match[1] ?? match[0];
  return normalizeDateCandidate(capture);
}

function makeRuleCandidates(
  source: "html" | "url",
  sourceText: string,
): RuleMatchCandidate[] {
  const presets: Array<{ label: string; pattern: string }> =
    source === "html"
      ? [
          {
            label: "JSON emission field",
            pattern: '"emission":"(\\d{2}/\\d{2}/\\d{4})"',
          },
          {
            label: "HTML datetime content",
            pattern: 'content="(\\d{4}-\\d{2}-\\d{2})T[^"]*"',
          },
          {
            label: "datemi span",
            pattern: 'class="datemi"[^>]*>(\\d{2}/\\d{2}/\\d{4})<',
          },
          {
            label: "ISO date in page",
            pattern: "\\b(\\d{4}-\\d{2}-\\d{2})\\b",
          },
          {
            label: "Slash date in page",
            pattern: "\\b(\\d{2}/\\d{2}/\\d{4})\\b",
          },
        ]
      : [
          {
            label: "dd-mm-yy in URL",
            pattern: "/(\\d{2}-\\d{2}-\\d{2})(?:/|$)",
          },
          {
            label: "yyyy-mm-dd in URL",
            pattern: "/(\\d{4}-\\d{2}-\\d{2})(?:/|$)",
          },
        ];

  const candidates: RuleMatchCandidate[] = [];
  for (const preset of presets) {
    const value = tryExtractWithRegex(sourceText, preset.pattern);
    if (!value) continue;
    candidates.push({
      label: `${preset.label} → ${value}`,
      pattern: preset.pattern,
      source,
      value,
    });
  }

  const unique = new Map<string, RuleMatchCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.pattern}::${candidate.value}`;
    if (!unique.has(key)) unique.set(key, candidate);
  }
  return Array.from(unique.values());
}

async function loadRules(): Promise<RulesFile> {
  try {
    const content = await readFile(RULES_FILE_PATH, "utf8");
    const parsed = JSON.parse(content) as Partial<RulesFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.rules)) {
      return { version: 1, rules: [] };
    }

    const rules: DateExtractionRule[] = [];
    for (const rule of parsed.rules) {
      if (
        rule &&
        typeof rule.domain === "string" &&
        typeof rule.pattern === "string" &&
        (rule.source === "html" || rule.source === "url")
      ) {
        rules.push({
          domain: rule.domain,
          source: rule.source,
          pattern: rule.pattern,
        });
      }
    }
    return { version: 1, rules };
  } catch {
    return { version: 1, rules: [] };
  }
}

async function saveRulesFile(file: RulesFile): Promise<void> {
  await mkdir(join(homedir(), ".pi", "agent", "extensions"), {
    recursive: true,
  });
  const serialized = `${JSON.stringify(file, null, 2)}\n`;
  await writeFile(RULES_FILE_PATH, serialized, "utf8");
}

function matchesDomain(url: string, domain: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const normalizedDomain = domain.trim().toLowerCase();
    if (!normalizedDomain) return false;
    return (
      hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`)
    );
  } catch {
    return false;
  }
}

async function extractDateFromCustomRules(
  url: string,
  html: string | undefined,
  rules: DateExtractionRule[],
): Promise<string | undefined> {
  for (const rule of rules) {
    if (!matchesDomain(url, rule.domain)) continue;
    const sourceText = rule.source === "url" ? url : html;
    if (!sourceText) continue;
    const extracted = tryExtractWithRegex(sourceText, rule.pattern);
    if (extracted) return extracted;
  }
  return undefined;
}

async function ensureWritableDirectory(
  path: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await access(path, constants.F_OK);
    await access(path, constants.W_OK);
    return { ok: true };
  } catch {
    try {
      await mkdir(path, { recursive: true });
      await access(path, constants.W_OK);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Unable to access destination folder",
      };
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function commandStatus(
  pi: ExtensionAPI,
  command: string,
  args: string[],
  signal: AbortSignal | undefined,
  cwd: string,
): Promise<{ available: boolean; version?: string; error?: string }> {
  const result = await pi.exec(command, args, { signal, cwd });
  if (result.code !== 0) {
    return {
      available: false,
      error: (result.stderr || result.stdout || `exit code ${result.code}`)
        .trim()
        .slice(0, 500),
    };
  }
  const version = (result.stdout || result.stderr)
    .trim()
    .split("\n")[0]
    ?.trim();
  return { available: true, version };
}

async function findApplicationBundle(
  appName: string,
): Promise<string | undefined> {
  const candidates = [
    join("/Applications", `${appName}.app`),
    join(homedir(), "Applications", `${appName}.app`),
    join("/System/Applications", `${appName}.app`),
  ];
  for (const candidate of candidates) {
    try {
      const candidateStat = await stat(candidate);
      if (candidateStat.isDirectory()) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function inspectMediaCapabilities(
  pi: ExtensionAPI,
  signal: AbortSignal | undefined,
  cwd: string,
): Promise<Record<string, unknown>> {
  const [ffmpeg, ffprobe, ytDlp, handbrakeCli, handbrakeApp, losslessCutApp] =
    await Promise.all([
      commandStatus(pi, "ffmpeg", ["-version"], signal, cwd),
      commandStatus(pi, "ffprobe", ["-version"], signal, cwd),
      commandStatus(pi, "yt-dlp", ["--version"], signal, cwd),
      commandStatus(pi, "HandBrakeCLI", ["--version"], signal, cwd),
      findApplicationBundle("HandBrake"),
      findApplicationBundle("LosslessCut"),
    ]);

  return {
    ffmpeg: { automation: ffmpeg.available, ...ffmpeg },
    ffprobe: { inspection: ffprobe.available, ...ffprobe },
    ytDlp: { downloads: ytDlp.available, ...ytDlp },
    handbrakeCli: { automation: handbrakeCli.available, ...handbrakeCli },
    handbrakeGui: { available: Boolean(handbrakeApp), path: handbrakeApp },
    losslessCutGui: {
      available: Boolean(losslessCutApp),
      path: losslessCutApp,
    },
    recommendations: {
      downloads: ytDlp.available
        ? "download_media_with_ytdlp"
        : "install yt-dlp",
      batchTranscode: handbrakeCli.available
        ? "transcode_videos_with_ffmpeg with engine=ffmpeg or engine=handbrake"
        : "transcode_videos_with_ffmpeg with engine=ffmpeg",
      manualTrimming: losslessCutApp
        ? "edit_media_losslessly mode=open-gui"
        : "ffmpeg-copy trim/remux",
      macLgTvDefault: "MP4 container, H.264 video, AAC audio",
    },
  };
}

function isHiddenPathSegment(path: string): boolean {
  return path
    .split("/")
    .some(
      (segment) =>
        segment.length > 0 &&
        segment.startsWith(".") &&
        segment !== "." &&
        segment !== "..",
    );
}

function isVideoFile(path: string): boolean {
  return (
    VIDEO_EXTENSIONS.has(extname(path).toLowerCase()) &&
    !isHiddenPathSegment(path)
  );
}

async function scanVideoFiles(
  root: string,
  recursive: boolean,
): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      if (recursive) {
        found.push(...(await scanVideoFiles(fullPath, recursive)));
      }
      continue;
    }
    if (entry.isFile() && isVideoFile(fullPath)) {
      found.push(fullPath);
    }
  }
  return found.sort((a, b) => a.localeCompare(b));
}

async function readAudioCodec(
  pi: ExtensionAPI,
  inputPath: string,
  signal: AbortSignal | undefined,
  cwd: string,
) {
  const result = await pi.exec(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=codec_name",
      "-of",
      "json",
      inputPath,
    ],
    { signal, cwd },
  );
  if (result.code !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as {
      streams?: Array<{ codec_name?: string }>;
    };
    return parsed.streams?.[0]?.codec_name?.toLowerCase();
  } catch {
    return undefined;
  }
}

function buildTranscodeFinalPath(
  inputPath: string,
  outputNaming: TranscodeOutputNaming,
): string {
  if (outputNaming === "same-path") return inputPath;
  const currentExt = extname(inputPath);
  if (currentExt.toLowerCase() === ".mp4") return inputPath;
  return `${inputPath.slice(0, -currentExt.length)}.mp4`;
}

function buildTranscodeTempPath(finalPath: string): string {
  const dir = dirname(finalPath);
  const ext = extname(finalPath) || ".mp4";
  const stem = basename(finalPath, ext);
  return join(dir, `.${stem}.pi-transcode-${Date.now()}-${randomUUID()}${ext}`);
}

function resolveTranscodeSettings(params: TranscodeParams): {
  engine: TranscodeEngine;
  profile: TranscodeProfile;
  videoCodec: TranscodeVideoCodec;
  crf: number;
  preset: string;
  audioMode: TranscodeAudioMode;
  audioBitrate: string;
  audioChannels: number;
  handbrakePreset?: string;
} {
  const profile: TranscodeProfile = params.profile ?? "custom";
  const requestedEngine: TranscodeEngine = params.engine ?? "auto";
  const engine: TranscodeEngine =
    requestedEngine === "auto"
      ? profile.startsWith("handbrake-")
        ? "handbrake"
        : "ffmpeg"
      : requestedEngine;
  const profileDefaults: Record<
    TranscodeProfile,
    {
      videoCodec: TranscodeVideoCodec;
      crf: number;
      preset: string;
      audioMode: TranscodeAudioMode;
      audioBitrate: string;
      audioChannels: number;
      handbrakePreset?: string;
    }
  > = {
    custom: {
      videoCodec: "libx265",
      crf: 23,
      preset: "medium",
      audioMode: "copy-ac3-else-aac",
      audioBitrate: "320k",
      audioChannels: 2,
    },
    "mac-lg-tv-h264": {
      videoCodec: "libx264",
      crf: 18,
      preset: "slow",
      audioMode: "aac",
      audioBitrate: "320k",
      audioChannels: 2,
    },
    "lg-tv-hevc": {
      videoCodec: "libx265",
      crf: 22,
      preset: "medium",
      audioMode: "copy-ac3-else-aac",
      audioBitrate: "320k",
      audioChannels: 2,
    },
    "hevc-archive": {
      videoCodec: "libx265",
      crf: 23,
      preset: "medium",
      audioMode: "copy-ac3-else-aac",
      audioBitrate: "320k",
      audioChannels: 2,
    },
    "handbrake-fast-1080p30": {
      videoCodec: "libx264",
      crf: 20,
      preset: "medium",
      audioMode: "aac",
      audioBitrate: "320k",
      audioChannels: 2,
      handbrakePreset: "Fast 1080p30",
    },
    "handbrake-hq-1080p30": {
      videoCodec: "libx264",
      crf: 18,
      preset: "slow",
      audioMode: "aac",
      audioBitrate: "320k",
      audioChannels: 2,
      handbrakePreset: "HQ 1080p30 Surround",
    },
    "handbrake-hq-2160p60-4k-hevc": {
      videoCodec: "libx265",
      crf: 22,
      preset: "medium",
      audioMode: "copy-ac3-else-aac",
      audioBitrate: "320k",
      audioChannels: 2,
      handbrakePreset: "H.265 MKV 2160p60 4K",
    },
    "handbrake-apple-compatible": {
      videoCodec: "libx264",
      crf: 20,
      preset: "medium",
      audioMode: "aac",
      audioBitrate: "320k",
      audioChannels: 2,
      handbrakePreset: "Apple 1080p30 Surround",
    },
    "handbrake-lg-tv-compatible": {
      videoCodec: "libx264",
      crf: 18,
      preset: "slow",
      audioMode: "aac",
      audioBitrate: "320k",
      audioChannels: 2,
      handbrakePreset: "HQ 1080p30 Surround",
    },
  };
  const defaults = profileDefaults[profile];
  return {
    engine,
    profile,
    videoCodec: params.videoCodec ?? defaults.videoCodec,
    crf: params.crf ?? defaults.crf,
    preset: params.preset?.trim() || defaults.preset,
    audioMode: params.audioMode ?? defaults.audioMode,
    audioBitrate: params.audioBitrate?.trim() || defaults.audioBitrate,
    audioChannels: params.audioChannels ?? defaults.audioChannels,
    handbrakePreset: params.handbrakePreset?.trim() || defaults.handbrakePreset,
  };
}

function buildHandBrakeArgs(options: {
  inputPath: string;
  tempPath: string;
  preset: string;
}): string[] {
  return [
    "--input",
    options.inputPath,
    "--output",
    options.tempPath,
    "--preset",
    options.preset,
  ];
}

async function handbrakePresetAvailable(
  pi: ExtensionAPI,
  preset: string,
  signal: AbortSignal | undefined,
  cwd: string,
): Promise<
  { ok: true } | { ok: false; error: string; availablePreview?: string }
> {
  const result = await pi.exec("HandBrakeCLI", ["--preset-list"], {
    signal,
    cwd,
  });
  if (result.code !== 0) {
    return {
      ok: false,
      error: (
        result.stderr ||
        result.stdout ||
        "HandBrakeCLI preset list failed"
      )
        .trim()
        .slice(0, 800),
    };
  }
  if (result.stdout.includes(preset)) return { ok: true };
  return {
    ok: false,
    error: `HandBrake preset not found: ${preset}`,
    availablePreview: result.stdout
      .split("\n")
      .filter((line) => line.includes("    ") && line.trim().length > 0)
      .slice(0, 30)
      .join("\n"),
  };
}

function buildTranscodeArgs(options: {
  inputPath: string;
  tempPath: string;
  videoCodec: TranscodeVideoCodec;
  crf: number;
  preset: string;
  audioCodec?: string;
  audioMode: TranscodeAudioMode;
  audioBitrate: string;
  audioChannels: number;
}): { args: string[]; audioAction: "copy" | "aac" | "none" } {
  const args = [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    options.inputPath,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
  ];

  if (options.videoCodec === "copy") {
    args.push("-c:v", "copy");
  } else {
    args.push(
      "-c:v",
      options.videoCodec,
      "-crf",
      String(options.crf),
      "-preset",
      options.preset,
    );
  }

  let audioAction: "copy" | "aac" | "none" = "none";
  if (options.audioCodec) {
    if (
      options.audioMode === "copy" ||
      (options.audioMode === "copy-ac3-else-aac" &&
        options.audioCodec === "ac3")
    ) {
      audioAction = "copy";
      args.push("-c:a", "copy");
    } else {
      audioAction = "aac";
      args.push(
        "-c:a",
        "aac",
        "-b:a",
        options.audioBitrate,
        "-ac",
        String(options.audioChannels),
      );
    }
  }

  args.push("-movflags", "+faststart", options.tempPath);
  return { args, audioAction };
}

function summarizeTranscodePlan(options: {
  roots: string[];
  fileCount: number;
  recursive: boolean;
  dryRun: boolean;
  replaceOriginals: boolean;
  outputNaming: TranscodeOutputNaming;
  engine: TranscodeEngine;
  crf: number;
  preset: string;
  profile: TranscodeProfile;
  videoCodec: TranscodeVideoCodec;
  handbrakePreset?: string;
  audioMode: TranscodeAudioMode;
  audioBitrate: string;
  audioChannels: number;
  previewItems: TranscodePlanItem[];
}): string {
  const lines: string[] = [];
  lines.push(`Roots: ${options.roots.join(", ")}`);
  lines.push(`Files found: ${options.fileCount}`);
  lines.push(`Recursive: ${options.recursive ? "yes" : "no"}`);
  lines.push(`Dry run: ${options.dryRun ? "yes" : "no"}`);
  lines.push(`Replace originals: ${options.replaceOriginals ? "yes" : "no"}`);
  lines.push(`Output naming: ${options.outputNaming}`);
  lines.push(`Engine: ${options.engine}`);
  lines.push(`Profile: ${options.profile}`);
  if (options.engine === "handbrake") {
    lines.push(`HandBrake preset: ${options.handbrakePreset ?? "not set"}`);
  } else {
    lines.push(
      options.videoCodec === "copy"
        ? "Video: copy original stream"
        : `Video: ${options.videoCodec} CRF ${options.crf}, preset ${options.preset}, original resolution`,
    );
    lines.push(
      `Audio: ${options.audioMode}${options.audioMode === "aac" || options.audioMode === "copy-ac3-else-aac" ? ` (${options.audioBitrate}, ${options.audioChannels} ch when converted)` : ""}`,
    );
  }
  lines.push("");
  lines.push("Preview commands:");
  for (const item of options.previewItems.slice(0, 8)) {
    lines.push(`- ${item.inputPath}`);
    lines.push(`  final: ${item.finalPath}`);
    lines.push(`  audio: ${item.audioCodec ?? "none"} -> ${item.audioAction}`);
    if (item.handbrakePreset)
      lines.push(`  HandBrake preset: ${item.handbrakePreset}`);
    lines.push(`  ${commandPreview(item.command, item.args)}`);
  }
  if (options.fileCount > options.previewItems.length) {
    lines.push(
      `... ${options.fileCount - options.previewItems.length} more file(s)`,
    );
  }
  return lines.join("\n");
}

function defaultLosslessOutputPath(
  inputPath: string,
  mode: LosslessEditMode,
  container: LosslessOutputContainer,
): string {
  const inputExt = extname(inputPath);
  const stem = inputExt ? inputPath.slice(0, -inputExt.length) : inputPath;
  const suffix =
    mode === "trim"
      ? "trim"
      : mode === "extract-audio"
        ? "audio"
        : mode === "remove-audio"
          ? "no-audio"
          : "remux";
  return `${stem}.${suffix}.${container}`;
}

function buildLosslessEditArgs(options: {
  mode: LosslessEditMode;
  inputPath: string;
  outputPath: string;
  start?: string;
  end?: string;
  replaceOutput: boolean;
}): string[] {
  const overwriteArgs = options.replaceOutput ? ["-y"] : ["-n"];
  switch (options.mode) {
    case "trim": {
      const args = ["-hide_banner", "-nostdin", ...overwriteArgs];
      if (options.start) args.push("-ss", options.start);
      if (options.end) args.push("-to", options.end);
      args.push(
        "-i",
        options.inputPath,
        "-map",
        "0",
        "-c",
        "copy",
        options.outputPath,
      );
      return args;
    }
    case "extract-audio":
      return [
        "-hide_banner",
        "-nostdin",
        ...overwriteArgs,
        "-i",
        options.inputPath,
        "-vn",
        "-map",
        "0:a:0",
        "-c:a",
        "copy",
        options.outputPath,
      ];
    case "remove-audio":
      return [
        "-hide_banner",
        "-nostdin",
        ...overwriteArgs,
        "-i",
        options.inputPath,
        "-map",
        "0:v:0",
        "-c:v",
        "copy",
        "-an",
        options.outputPath,
      ];
    case "remux":
    default:
      return [
        "-hide_banner",
        "-nostdin",
        ...overwriteArgs,
        "-i",
        options.inputPath,
        "-map",
        "0",
        "-c",
        "copy",
        options.outputPath,
      ];
  }
}

function stripControlCharacters(value: string): string {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mediaPreviewMetadata(candidate: MediaPreviewCandidate): string {
  return (
    [candidate.date, candidate.duration, candidate.availability]
      .filter(Boolean)
      .join(" | ") || "metadata unavailable"
  );
}

class MediaPreviewSelectionComponent implements Component {
  private cursor = 0;
  private readonly selected = new Set<number>();
  private finished = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly candidates: MediaPreviewCandidate[],
    private readonly warnings: string[],
    private readonly destinationPath: string,
    private readonly done: (result: MediaPreviewCandidate[] | null) => void,
  ) {}

  private finish(result: MediaPreviewCandidate[] | null): void {
    if (this.finished) return;
    this.finished = true;
    this.done(result);
  }

  private moveCursor(delta: number): void {
    if (!this.candidates.length) return;
    this.cursor = Math.max(
      0,
      Math.min(this.candidates.length - 1, this.cursor + delta),
    );
  }

  render(width: number): string[] {
    const lines = [
      this.theme.fg(
        "accent",
        this.theme.bold("Select media entries to download"),
      ),
      this.theme.fg(
        "muted",
        `${this.selected.size}/${this.candidates.length} selected`,
      ),
      this.theme.fg(
        "dim",
        `Destination: ${stripControlCharacters(this.destinationPath)}`,
      ),
      this.theme.fg(
        "dim",
        "Up/down move | Space toggle | a all | n none | Enter download | Esc cancel",
      ),
    ];
    for (const warning of this.warnings.slice(0, 3))
      lines.push(
        this.theme.fg("warning", `Warning: ${stripControlCharacters(warning)}`),
      );
    if (this.warnings.length > 3)
      lines.push(
        this.theme.fg(
          "warning",
          `${this.warnings.length - 3} more preview warning(s)`,
        ),
      );
    lines.push("");

    const availableRows = Math.max(
      1,
      this.tui.terminal.rows - lines.length - 1,
    );
    const firstVisible = Math.max(
      0,
      Math.min(this.cursor, this.candidates.length - availableRows),
    );
    const lastVisible = Math.min(
      this.candidates.length,
      firstVisible + availableRows,
    );
    for (let index = firstVisible; index < lastVisible; index += 1) {
      const candidate = this.candidates[index];
      const pointer =
        index === this.cursor ? this.theme.fg("accent", ">") : " ";
      const checkbox = this.selected.has(candidate.index)
        ? this.theme.fg("success", "[x]")
        : this.theme.fg("muted", "[ ]");
      const metadata = mediaPreviewMetadata(candidate);
      const prefix = `${pointer} ${checkbox} ${candidate.index}. `;
      const nameWidth = Math.max(
        12,
        width - visibleWidth(prefix) - visibleWidth(metadata) - 3,
      );
      const displayName = truncateToWidth(
        stripControlCharacters(candidate.displayName),
        nameWidth,
        "",
      );
      lines.push(
        truncateToWidth(`${prefix}${displayName} — ${metadata}`, width),
      );
    }
    if (this.candidates.length > availableRows)
      lines.push(
        this.theme.fg(
          "dim",
          `Showing ${firstVisible + 1}-${lastVisible} of ${this.candidates.length}`,
        ),
      );
    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) this.moveCursor(-1);
    else if (matchesKey(data, Key.down)) this.moveCursor(1);
    else if (matchesKey(data, Key.pageUp))
      this.moveCursor(-Math.max(1, this.tui.terminal.rows - 8));
    else if (matchesKey(data, Key.pageDown))
      this.moveCursor(Math.max(1, this.tui.terminal.rows - 8));
    else if (matchesKey(data, Key.home)) this.cursor = 0;
    else if (matchesKey(data, Key.end))
      this.cursor = Math.max(0, this.candidates.length - 1);
    else if (matchesKey(data, Key.space)) {
      const candidate = this.candidates[this.cursor];
      if (candidate) {
        if (this.selected.has(candidate.index))
          this.selected.delete(candidate.index);
        else this.selected.add(candidate.index);
      }
    } else if (data === "a" || data === "A") {
      for (const candidate of this.candidates)
        this.selected.add(candidate.index);
    } else if (data === "n" || data === "N") {
      this.selected.clear();
    } else if (matchesKey(data, Key.enter)) {
      this.finish(
        this.candidates.filter((candidate) =>
          this.selected.has(candidate.index),
        ),
      );
      return;
    } else if (matchesKey(data, Key.escape)) {
      this.finish(null);
      return;
    } else return;
    this.tui.requestRender();
  }

  invalidate(): void {}
}

async function chooseMode(
  ui: PickerUI,
  initialMode: DownloadParams["mode"],
): Promise<DownloadMode> {
  if (initialMode) return initialMode;
  const choice = await ui.select("Download type", ["Audio", "Video"]);
  if (choice === "Video") return "video";
  return "audio";
}

// Only "best" is guaranteed never to re-encode: yt-dlp copies the source stream
// straight into its container. Every other target can invoke an encoder, and
// which ones do depends on the source codec, so none of them is safe to accept
// on trust. This parameter is filled in by the model, not the user, so a
// re-encode is never taken silently — the user confirms it, or it falls back to
// "best". Cancelling falls back too, because the safe answer is the quiet one.
async function chooseAudioFormat(
  ui: PickerUI,
  initial: DownloadParams["audioFormat"],
): Promise<AudioFormat> {
  if (!initial || initial === "best") return "best";
  const keepSource = "Keep source audio (best, no re-encode)";
  const convert = `Convert to ${initial} (re-encodes, loses quality)`;
  const selection = await ui.select(`Convert this audio to ${initial}?`, [
    keepSource,
    convert,
  ]);
  return selection === convert ? initial : "best";
}

async function chooseVideoContainer(
  ui: PickerUI,
  initial: DownloadParams["videoContainer"],
): Promise<VideoContainer> {
  if (initial) return initial;
  const options = [
    "Use default: mkv (best stream preservation; may not open in QuickTime/iOS)",
    "mp4",
    "webm",
    "mov",
  ];
  const selection = await ui.select("Video container", options);
  if (!selection || selection.startsWith("Use default:")) return "mkv";
  return selection as VideoContainer;
}

async function choosePlaylistMode(
  ui: PickerUI,
  initial: DownloadParams["playlistMode"],
  hasPlaylistUrls: boolean,
): Promise<PlaylistMode> {
  if (initial) return initial;
  if (!hasPlaylistUrls) return "single";
  const selection = await ui.select("Playlist behavior", [
    "Single item only (default)",
    "Full playlist",
  ]);
  return selection === "Full playlist" ? "playlist" : "single";
}

async function chooseYoutubeCookieBrowser(
  ui: PickerUI,
  initial: DownloadParams["cookiesFromBrowser"],
  hasYoutubeUrls: boolean,
  hasCookiesFile: boolean,
): Promise<CookieBrowser> {
  if (initial) return initial;
  if (!hasYoutubeUrls || hasCookiesFile) return "none";

  const selection = await ui.select("Use browser cookies for YouTube?", [
    "No cookies",
    "Safari",
    "Chrome",
    "Brave",
    "Firefox",
    "Edge",
    "Chromium",
    "Vivaldi",
  ]);

  switch (selection) {
    case "Safari":
      return "safari";
    case "Chrome":
      return "chrome";
    case "Brave":
      return "brave";
    case "Firefox":
      return "firefox";
    case "Edge":
      return "edge";
    case "Chromium":
      return "chromium";
    case "Vivaldi":
      return "vivaldi";
    default:
      return "none";
  }
}

function selectDestinationPath(destinationPath: string | undefined): {
  path: string;
  source: "default" | "custom";
} {
  if (destinationPath && destinationPath.trim().length > 0) {
    const trimmed = destinationPath.trim();
    // Expand ~ to the real home directory so the model can pass ~/Downloads/... naturally.
    const expanded =
      trimmed === "~"
        ? homedir()
        : trimmed.startsWith("~/")
          ? join(homedir(), trimmed.slice(2))
          : trimmed;
    return { path: expanded, source: "custom" };
  }
  return { path: join(homedir(), "Downloads"), source: "default" };
}

function buildOutputTemplate(destinationPath: string): string {
  return join(
    destinationPath,
    "%(release_date>%Y.%m.%d,upload_date>%Y.%m.%d,release_timestamp>%Y.%m.%d,timestamp>%Y.%m.%d|UnknownDate)s — %(title)s.%(ext)s",
  );
}

function buildOutputTemplateWithFixedDate(
  destinationPath: string,
  date: string,
): string {
  return join(destinationPath, `${date} — %(title)s.%(ext)s`);
}

function buildJobs(options: {
  mode: DownloadMode;
  audioFormat?: AudioFormat;
  videoContainer?: VideoContainer;
  playlistMode: PlaylistMode;
  overwriteMode: OverwriteMode;
  outputTemplate: string;
  destinationPath: string;
  urls: string[];
  dateOverrides: Map<string, string>;
  cookiesFromBrowser?: CookieBrowser;
  cookiesProfile?: string;
  cookiesFile?: string;
  continueOnErrors: boolean;
  playlistItems?: string;
  sleepRequests?: number;
  compatibilityProfile: DownloadCompatibilityProfile;
}): DownloadJob[] {
  const {
    mode,
    audioFormat,
    videoContainer,
    playlistMode,
    overwriteMode,
    outputTemplate,
    destinationPath,
    urls,
    dateOverrides,
    cookiesFromBrowser,
    cookiesProfile,
    cookiesFile,
    continueOnErrors,
    playlistItems,
    sleepRequests,
    compatibilityProfile,
  } = options;
  const urlsWithOverride = urls.filter((url) => dateOverrides.has(url));
  const urlsWithoutOverride = urls.filter((url) => !dateOverrides.has(url));

  const sharedArgs: string[] = [];
  if (mode === "audio") {
    sharedArgs.push(
      "-x",
      "--audio-quality",
      "0",
      "--audio-format",
      audioFormat ?? "best",
    );
  } else if (compatibilityProfile === "mac-lg-tv") {
    sharedArgs.push(
      "-f",
      "bv*[ext=mp4][vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4][vcodec^=avc1]/best[ext=mp4]/best",
      "--merge-output-format",
      "mp4",
    );
  } else {
    sharedArgs.push(
      "-f",
      "bv*+ba/b",
      "--merge-output-format",
      videoContainer ?? "mkv",
    );
  }

  if (overwriteMode === "skip") {
    sharedArgs.push("--no-overwrites");
  } else {
    sharedArgs.push("--force-overwrites");
  }

  if (continueOnErrors) {
    sharedArgs.push("--ignore-errors");
  }

  if (playlistItems?.trim()) {
    sharedArgs.push("--playlist-items", playlistItems.trim());
  }

  if (
    typeof sleepRequests === "number" &&
    Number.isFinite(sleepRequests) &&
    sleepRequests > 0
  ) {
    sharedArgs.push("--sleep-requests", String(sleepRequests));
  }

  if (cookiesFile?.trim()) {
    sharedArgs.push("--cookies", cookiesFile.trim());
  } else if (cookiesFromBrowser && cookiesFromBrowser !== "none") {
    const cookieSource = cookiesProfile?.trim()
      ? `${cookiesFromBrowser}:${cookiesProfile.trim()}`
      : cookiesFromBrowser;
    sharedArgs.push("--cookies-from-browser", cookieSource);
  }

  const jobs: DownloadJob[] = [];

  if (urlsWithoutOverride.length > 0) {
    const playlistUrls = urlsWithoutOverride.filter(isLikelyPlaylistUrl);
    const singleUrls = urlsWithoutOverride.filter(
      (url) => !isLikelyPlaylistUrl(url),
    );
    const mixed = playlistUrls.length > 0 && singleUrls.length > 0;

    if (!mixed) {
      const allArePlaylistLike =
        playlistUrls.length === urlsWithoutOverride.length;
      const playlistFlag =
        allArePlaylistLike && playlistMode === "playlist"
          ? "--yes-playlist"
          : "--no-playlist";
      jobs.push({
        label: allArePlaylistLike ? "playlist URLs" : "single URLs",
        urls: urlsWithoutOverride,
        args: [
          ...sharedArgs,
          "--output",
          outputTemplate,
          playlistFlag,
          ...urlsWithoutOverride,
        ],
      });
    } else {
      if (singleUrls.length > 0) {
        jobs.push({
          label: "single URLs",
          urls: singleUrls,
          args: [
            ...sharedArgs,
            "--output",
            outputTemplate,
            "--no-playlist",
            ...singleUrls,
          ],
        });
      }
      if (playlistUrls.length > 0) {
        const playlistFlag =
          playlistMode === "playlist" ? "--yes-playlist" : "--no-playlist";
        jobs.push({
          label: "playlist-like URLs",
          urls: playlistUrls,
          args: [
            ...sharedArgs,
            "--output",
            outputTemplate,
            playlistFlag,
            ...playlistUrls,
          ],
        });
      }
    }
  }

  for (const url of urlsWithOverride) {
    const forcedDate = dateOverrides.get(url);
    if (!forcedDate) continue;
    const playlistFlag =
      isLikelyPlaylistUrl(url) && playlistMode === "playlist"
        ? "--yes-playlist"
        : "--no-playlist";
    const overrideLabel = isBbcProgrammesUrl(url)
      ? "BBC URL (page date fallback)"
      : isRtveAudioUrl(url)
        ? "RTVE URL (date fallback)"
        : "Custom-rule URL (date override)";
    jobs.push({
      label: overrideLabel,
      urls: [url],
      args: [
        ...sharedArgs,
        "--output",
        buildOutputTemplateWithFixedDate(destinationPath, forcedDate),
        playlistFlag,
        url,
      ],
    });
  }

  return jobs;
}

// Spelled out in the confirmation because the model picks this parameter and the
// user is the one who pays for a bad choice.
function audioFormatQualityNote(format: AudioFormat): string {
  if (format === "best") return "";
  if (format === "m4a" || format === "aac")
    return " — copies AAC sources unchanged, re-encodes anything else";
  if (format === "flac" || format === "wav" || format === "alac")
    return " — re-encodes to lossless: no quality gained over a lossy source, much larger files";
  return ` — WARNING: re-encodes lossy audio into ${format}, losing quality. Omit audioFormat to copy the source stream instead.`;
}

async function fetchBbcJson(
  pi: ExtensionAPI,
  cwd: string,
  url: string,
  signal: AbortSignal | undefined,
): Promise<any | undefined> {
  try {
    const result = await pi.exec(
      "curl",
      ["-sL", "--max-time", "20", "-A", "Mozilla/5.0", url],
      { signal, cwd },
    );
    if (result.code !== 0 || !result.stdout.trim()) return undefined;
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

function tracklistCell(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function tracklistTimestamp(totalSeconds: unknown): string {
  const seconds = Number(totalSeconds);
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  return `${hours > 0 ? `${hours}:` : ""}${String(minutes).padStart(
    hours > 0 ? 2 : 1,
    "0",
  )}:${String(rest).padStart(2, "0")}`;
}

// Named to match the audio file yt-dlp writes ("<date> — <brand>, <episode>"),
// so the tracklist sorts directly beside the recording it belongs to.
function bbcTracklistBasename(programme: any): string | undefined {
  const episodeTitle = String(programme?.title ?? "").trim();
  if (!episodeTitle) return undefined;
  const brand = String(
    programme?.parent?.programme?.title ??
      programme?.parent?.programme?.parent?.programme?.title ??
      "",
  ).trim();
  const date = String(programme?.first_broadcast_date ?? "").slice(0, 10);
  const stamp = /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? date.replace(/-/g, ".")
    : "UnknownDate";
  const title = brand ? `${brand}, ${episodeTitle}` : episodeTitle;
  return `${stamp} — ${title}`.replace(/[/\\:*?"<>|]/g, "-").slice(0, 180);
}

function buildBbcTracklistMarkdown(
  programme: any,
  segmentEvents: any[],
  pid: string,
): string | undefined {
  const tracks = segmentEvents.filter(
    (event) => event?.segment?.type === "music",
  );
  if (tracks.length === 0) return undefined;

  const brand = String(programme?.parent?.programme?.title ?? "").trim();
  const episodeTitle = String(programme?.title ?? pid).trim();
  const lines: string[] = [
    `# ${brand ? `${brand} — ${episodeTitle}` : episodeTitle}`,
    "",
  ];

  const facts: string[] = [];
  const date = String(programme?.first_broadcast_date ?? "").slice(0, 10);
  if (date) facts.push(`**Broadcast** ${date}`);
  const station = programme?.ownership?.service?.title;
  if (station) facts.push(`**Station** ${tracklistCell(station)}`);
  if (facts.length > 0) lines.push(facts.join(" · "), "");

  lines.push(
    `[Programme page](https://www.bbc.co.uk/programmes/${pid}) · ` +
      `[BBC Sounds](https://www.bbc.co.uk/sounds/play/${pid})`,
    "",
    `## Tracklist (${tracks.length})`,
    "",
    "| # | Time | Artist | Track | Release | Label |",
    "|---:|---|---|---|---|---|",
  );
  tracks.forEach((event, index) => {
    const segment = event.segment ?? {};
    lines.push(
      `| ${event.position ?? index + 1} | ${tracklistTimestamp(
        event.version_offset,
      )} | ${tracklistCell(segment.artist)} | ${tracklistCell(
        segment.track_title,
      )} | ${tracklistCell(segment.release_title)} | ${tracklistCell(
        segment.record_label,
      )} |`,
    );
  });
  lines.push("", "---", "", `Tracklist data from BBC programme \`${pid}\`.`, "");
  return lines.join("\n");
}

// BBC publishes the music played during a programme as structured data. Write it
// out beside the audio, because a recording without its tracklist loses the one
// thing the listener most often wants to look up afterwards.
async function writeBbcTracklists(
  pi: ExtensionAPI,
  cwd: string,
  urls: string[],
  destinationPath: string,
  signal: AbortSignal | undefined,
  onUpdate?: (text: string) => void,
): Promise<{ written: string[]; skipped: string[] }> {
  const written: string[] = [];
  const skipped: string[] = [];
  const pids = dedupeUrls(
    urls.filter(isBbcProgrammesUrl).map((url) => bbcPidFromUrl(url) ?? ""),
  ).filter(Boolean);
  for (const pid of pids) {
    const [meta, segments] = await Promise.all([
      fetchBbcJson(pi, cwd, `https://www.bbc.co.uk/programmes/${pid}.json`, signal),
      fetchBbcJson(
        pi,
        cwd,
        `https://www.bbc.co.uk/programmes/${pid}/segments.json`,
        signal,
      ),
    ]);
    const programme = meta?.programme;
    const events = Array.isArray(segments?.segment_events)
      ? segments.segment_events
      : [];
    const markdown = programme
      ? buildBbcTracklistMarkdown(programme, events, pid)
      : undefined;
    const base = programme ? bbcTracklistBasename(programme) : undefined;
    if (!markdown || !base) {
      skipped.push(pid);
      continue;
    }
    const target = join(destinationPath, `${base}.md`);
    try {
      await writeFile(target, markdown, "utf8");
      written.push(target);
    } catch {
      skipped.push(pid);
    }
  }
  if (written.length > 0)
    onUpdate?.(
      `Wrote ${written.length} tracklist${written.length === 1 ? "" : "s"}`,
    );
  return { written, skipped };
}

function buildPlanSummary(options: {
  mode: DownloadMode;
  destinationPath: string;
  destinationSource: "default" | "custom";
  audioFormat?: AudioFormat;
  videoContainer?: VideoContainer;
  playlistMode: PlaylistMode;
  overwriteMode: OverwriteMode;
  compatibilityProfile: DownloadCompatibilityProfile;
  cookiesFromBrowser?: CookieBrowser;
  cookiesProfile?: string;
  cookiesFile?: string;
  continueOnErrors: boolean;
  playlistItems?: string;
  sleepRequests?: number;
  jobs: DownloadJob[];
}): string {
  const lines: string[] = [];
  lines.push(`Mode: ${options.mode}`);
  lines.push(
    `Destination: ${options.destinationPath} (${options.destinationSource})`,
  );
  if (options.mode === "audio") {
    const audioFormat = options.audioFormat ?? "best";
    lines.push(
      `Audio extension: ${audioFormat}${
        options.audioFormat
          ? audioFormatQualityNote(audioFormat)
          : " (default — copies the source stream, no re-encode)"
      }`,
    );
  } else if (options.compatibilityProfile === "mac-lg-tv") {
    lines.push(
      "Video profile: mac-lg-tv (prefer MP4/H.264 video + M4A/AAC audio)",
    );
  } else {
    lines.push(
      `Video container: ${options.videoContainer ?? "mkv"}${options.videoContainer ? "" : " (default)"}`,
    );
  }
  lines.push(`Compatibility profile: ${options.compatibilityProfile}`);
  lines.push(`Playlist mode: ${options.playlistMode}`);
  lines.push(`Overwrite mode: ${options.overwriteMode}`);
  lines.push(
    `Continue on item errors: ${options.continueOnErrors ? "yes" : "no"}`,
  );
  if (options.playlistItems?.trim()) {
    lines.push(`Playlist items: ${options.playlistItems.trim()}`);
  }
  if (typeof options.sleepRequests === "number" && options.sleepRequests > 0) {
    lines.push(`Sleep between requests: ${options.sleepRequests}s`);
  }
  if (options.cookiesFile?.trim()) {
    lines.push(`Cookies: file ${options.cookiesFile.trim()}`);
  } else if (
    options.cookiesFromBrowser &&
    options.cookiesFromBrowser !== "none"
  ) {
    lines.push(
      `Cookies: ${options.cookiesFromBrowser}${options.cookiesProfile?.trim() ? ` profile ${options.cookiesProfile.trim()}` : ""}`,
    );
  } else {
    lines.push("Cookies: none");
  }
  lines.push(`Jobs: ${options.jobs.length}`);
  for (const [index, job] of options.jobs.entries()) {
    lines.push(
      `  ${index + 1}. ${job.label} (${job.urls.length} URL${job.urls.length === 1 ? "" : "s"})`,
    );
    lines.push(`     ${commandPreview("yt-dlp", job.args)}`);
  }
  return lines.join("\n");
}

function extractAuthHint(stderr: string, stdout: string): string | undefined {
  const combined = `${stderr}\n${stdout}`.toLowerCase();
  if (
    combined.includes("sign in to confirm your age") ||
    combined.includes("age-restricted") ||
    combined.includes("this video is private") ||
    combined.includes("cookies") ||
    combined.includes("captcha") ||
    combined.includes("blocked it from display") ||
    combined.includes("not a bot")
  ) {
    return "This looks authentication/captcha-related. Retry with browser cookies from a browser where YouTube is logged in and the playlist videos can play. If a rightsholder blocks playback even in the browser, cookies will not bypass that restriction.";
  }
  return undefined;
}

function summarizeResults(
  results: DownloadJobResult[],
  destinationPath: string,
): string {
  const successful = results.filter((result) => result.code === 0).length;
  const failed = results.length - successful;
  const lines: string[] = [];
  lines.push(
    `Download completed. Success: ${successful}/${results.length}, Failed: ${failed}/${results.length}`,
  );
  lines.push(`Output folder: ${destinationPath}`);

  for (const result of results) {
    lines.push("");
    lines.push(`Job: ${result.label}`);
    lines.push(`URLs: ${result.urlCount}`);
    lines.push(`Exit code: ${result.code}`);
    if (result.code !== 0) {
      const hint = extractAuthHint(result.stderr, result.stdout);
      if (hint) {
        lines.push(`Hint: ${hint}`);
      }
      if (result.stderr.trim().length > 0) {
        lines.push(`stderr:\n${result.stderr.trim().slice(0, 4000)}`);
      } else if (result.stdout.trim().length > 0) {
        lines.push(`stdout:\n${result.stdout.trim().slice(0, 4000)}`);
      }
    }
  }

  return lines.join("\n");
}

export default function ytDlpFfmpegExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "download_media_with_ytdlp",
    label: "Download Media",
    description:
      "Download audio or video from supported URLs using yt-dlp and ffmpeg. Use this when users ask to download media files.",
    promptSnippet:
      "Download audio/video with yt-dlp + ffmpeg to a user-selected destination",
    promptGuidelines: [
      "Use this tool for media download requests instead of generating raw yt-dlp commands.",
      "Provide all user URLs in one call whenever possible.",
      "URLs that name one item — including BBC /programmes/<pid> episode links — download directly with no list preview.",
      "Only genuine collections (playlists, series, feeds, episode indexes) show the selectable list preview when playlistMode is omitted; preview=true forces it for any URL.",
      "Pass every episode URL in one call; there is no need to split a bulk list or to pick entries yourself.",
      "Preview discovery never downloads media. Only the entries explicitly selected in the list may reach the normal download confirmation.",
      "NEVER pass audioFormat unless the user explicitly named a format. Omitting it keeps the source audio unchanged; choosing mp3/opus/vorbis yourself silently destroys quality.",
      "NEVER manually ask the user about browser cookies — the tool presents that picker itself. Just call the tool.",
      "NEVER run mkdir or bash to pre-create the destination folder — the tool creates it automatically.",
      "destinationPath accepts ~/... paths as well as absolute paths — pass it directly as the user stated it.",
      "Video downloads default to compatibilityProfile='mac-lg-tv' for Mac and LG TV playback.",
      "Use compatibilityProfile='source' only when the user explicitly asks for best/source format over playback compatibility.",
    ],
    parameters: DownloadParamsSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [
            {
              type: "text",
              text: "Error: interactive confirmation UI is required for this tool.",
            },
          ],
          details: { reason: "no_ui" },
          isError: true,
        };
      }

      let urls = dedupeUrls(params.urls);
      if (urls.length === 0) {
        return {
          content: [
            { type: "text", text: "Error: no valid URLs were provided." },
          ],
          details: { reason: "no_urls" },
          isError: true,
        };
      }

      const mode = await chooseMode(ctx.ui, params.mode);
      const compatibilityProfile: DownloadCompatibilityProfile =
        params.compatibilityProfile ??
        (mode === "video" ? "mac-lg-tv" : "source");
      const selectedAudioFormat =
        mode === "audio"
          ? await chooseAudioFormat(ctx.ui, params.audioFormat)
          : undefined;
      const selectedVideoContainer =
        mode === "video"
          ? compatibilityProfile === "mac-lg-tv"
            ? "mp4"
            : await chooseVideoContainer(ctx.ui, params.videoContainer)
          : undefined;
      // /programmes/<pid> is the shape of both a single episode and a whole
      // brand, so ask BBC which it is before deciding whether a picker is
      // warranted. Episode URLs stay single and skip the picker entirely.
      urls = await resolveBbcProgrammeUrls(pi, ctx.cwd, urls, signal, (text) =>
        onUpdate?.({
          content: [{ type: "text", text }],
          details: { phase: "resolve" },
        }),
      );

      const shouldPreview =
        params.preview === true ||
        (params.playlistMode === undefined && urls.some(isMediaPlaylistUrl));
      const hasPlaylistUrls = urls.some(isMediaPlaylistUrl);
      const playlistMode: PlaylistMode = shouldPreview
        ? "single"
        : await choosePlaylistMode(
            ctx.ui,
            params.playlistMode,
            hasPlaylistUrls,
          );
      const overwriteMode: OverwriteMode = params.overwriteMode ?? "skip";
      const continueOnErrors =
        params.continueOnErrors ?? playlistMode === "playlist";
      const cookiesProfile = params.cookiesProfile?.trim();
      const cookiesFile = params.cookiesFile?.trim();
      const hasYoutubeUrls = urls.some(isYoutubeUrl);
      const cookiesFromBrowser = await chooseYoutubeCookieBrowser(
        ctx.ui,
        params.cookiesFromBrowser,
        hasYoutubeUrls,
        Boolean(cookiesFile),
      );
      const playlistItems = params.playlistItems?.trim();
      const sleepRequests = params.sleepRequests;

      const destinationSelection = selectDestinationPath(
        params.destinationPath,
      );
      if (!isAbsolute(destinationSelection.path)) {
        return {
          content: [
            {
              type: "text",
              text: `Error: destination path must be absolute: ${destinationSelection.path}`,
            },
          ],
          details: {
            reason: "destination_not_absolute",
            destinationPath: destinationSelection.path,
          },
          isError: true,
        };
      }

      if (cookiesFile && !isAbsolute(cookiesFile)) {
        return {
          content: [
            {
              type: "text",
              text: `Error: cookies file path must be absolute: ${cookiesFile}`,
            },
          ],
          details: { reason: "cookies_file_not_absolute", cookiesFile },
          isError: true,
        };
      }

      if (cookiesFile) {
        try {
          await access(cookiesFile, constants.R_OK);
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error: cookies file is not readable: ${cookiesFile}\n${
                  error instanceof Error ? error.message : "Unable to read file"
                }`,
              },
            ],
            details: {
              reason: "cookies_file_not_readable",
              cookiesFile,
              error: error instanceof Error ? error.message : String(error),
            },
            isError: true,
          };
        }
      }

      const destinationCheck = await ensureWritableDirectory(
        destinationSelection.path,
      );
      if (destinationCheck.ok === false) {
        return {
          content: [
            {
              type: "text",
              text: `Error: destination folder is not writable: ${destinationSelection.path}\n${destinationCheck.error}`,
            },
          ],
          details: {
            reason: "destination_not_writable",
            destinationPath: destinationSelection.path,
            error: destinationCheck.error,
          },
          isError: true,
        };
      }

      const ytDlpCheck = await pi.exec("yt-dlp", ["--version"], {
        signal,
        cwd: ctx.cwd,
      });
      if (ytDlpCheck.code !== 0) {
        return {
          content: [
            { type: "text", text: "Error: yt-dlp is not available in PATH." },
          ],
          details: { reason: "missing_yt_dlp", stderr: ytDlpCheck.stderr },
          isError: true,
        };
      }

      const ffmpegCheck = await pi.exec("ffmpeg", ["-version"], {
        signal,
        cwd: ctx.cwd,
      });
      if (ffmpegCheck.code !== 0) {
        return {
          content: [
            { type: "text", text: "Error: ffmpeg is not available in PATH." },
          ],
          details: { reason: "missing_ffmpeg", stderr: ffmpegCheck.stderr },
          isError: true,
        };
      }

      const previewOptions: Partial<DownloadParams> = {
        ...params,
        mode,
        audioFormat: selectedAudioFormat,
        videoContainer: selectedVideoContainer,
        cookiesFromBrowser,
        cookiesProfile,
        cookiesFile,
      };
      let downloadUrls = [...urls];
      let previewDetails: MediaPreviewJob[] | undefined;
      if (shouldPreview) {
        const preview = await discoverMediaPreview(
          pi,
          ctx.cwd,
          urls,
          previewOptions,
          signal,
          (text) =>
            onUpdate?.({
              content: [{ type: "text", text }],
              details: { phase: "preview" },
            }),
        );
        previewDetails = preview.jobs;
        if (preview.candidates.length === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  preview.warnings.join("\n") ||
                  "No selectable media entries were found. No download was started.",
              },
            ],
            details: {
              reason: "no_preview_candidates",
              preview: previewDetails,
            },
            isError: true,
          };
        }
        const selectedCandidates = await ctx.ui.custom<
          MediaPreviewCandidate[] | null
        >(
          (tui, theme, _keybindings, done) =>
            new MediaPreviewSelectionComponent(
              tui as unknown as TUI,
              theme,
              preview.candidates.filter((candidate) => candidate.url),
              preview.warnings,
              destinationSelection.path,
              done,
            ),
        );
        if (!selectedCandidates) {
          return {
            content: [{ type: "text", text: "Download cancelled by user." }],
            details: {
              cancelled: true,
              destinationPath: destinationSelection.path,
              preview: previewDetails,
            },
            isError: false,
          };
        }
        if (selectedCandidates.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No media entries selected; download cancelled.",
              },
            ],
            details: {
              cancelled: true,
              reason: "no_media_entries_selected",
              destinationPath: destinationSelection.path,
              preview: previewDetails,
            },
            isError: false,
          };
        }
        downloadUrls = selectedCandidates
          .map((candidate) => candidate.url)
          .filter(Boolean);
      }

      const customRules = await loadRules();
      const dateOverrides = new Map<string, string>();
      for (const url of downloadUrls) {
        let pageHtml: string | undefined;
        let shouldFetchPage = false;
        for (const rule of customRules.rules) {
          if (rule.source === "html" && matchesDomain(url, rule.domain)) {
            shouldFetchPage = true;
            break;
          }
        }
        if (isBbcProgrammesUrl(url) || isRtveAudioUrl(url)) {
          shouldFetchPage = true;
        }
        if (shouldFetchPage) {
          const pageResult = await pi.exec(
            "curl",
            ["-sL", "--max-time", "20", url],
            { signal, cwd: ctx.cwd },
          );
          if (pageResult.code === 0 && pageResult.stdout.trim().length > 0) {
            pageHtml = pageResult.stdout;
          }
        }

        const customDate = await extractDateFromCustomRules(
          url,
          pageHtml,
          customRules.rules,
        );
        if (customDate) {
          dateOverrides.set(url, customDate);
          continue;
        }

        if (isBbcProgrammesUrl(url)) {
          if (!pageHtml) continue;
          const extractedDate = extractBbcBroadcastDate(pageHtml);
          if (extractedDate) {
            dateOverrides.set(url, extractedDate);
          }
          continue;
        }

        if (isRtveAudioUrl(url)) {
          if (pageHtml) {
            const extractedDate = extractRtveEmissionDate(pageHtml);
            if (extractedDate) {
              dateOverrides.set(url, extractedDate);
              continue;
            }
          }

          const extractedDateFromUrl = extractRtveEmissionDateFromUrl(url);
          if (extractedDateFromUrl) {
            dateOverrides.set(url, extractedDateFromUrl);
          }
        }
      }

      const outputTemplate = buildOutputTemplate(destinationSelection.path);
      const jobs = buildJobs({
        mode,
        audioFormat: selectedAudioFormat,
        videoContainer: selectedVideoContainer,
        playlistMode,
        overwriteMode,
        outputTemplate,
        destinationPath: destinationSelection.path,
        urls: downloadUrls,
        dateOverrides,
        cookiesFromBrowser,
        cookiesProfile,
        cookiesFile,
        continueOnErrors,
        playlistItems,
        sleepRequests,
        compatibilityProfile,
      });

      const planSummary = buildPlanSummary({
        mode,
        destinationPath: destinationSelection.path,
        destinationSource: destinationSelection.source,
        audioFormat: selectedAudioFormat,
        videoContainer: selectedVideoContainer,
        playlistMode,
        overwriteMode,
        compatibilityProfile,
        cookiesFromBrowser,
        cookiesProfile,
        cookiesFile,
        continueOnErrors,
        playlistItems,
        sleepRequests,
        jobs,
      });
      const confirmed = await ctx.ui.confirm(
        "Run yt-dlp download?",
        planSummary,
      );
      if (!confirmed) {
        return {
          content: [{ type: "text", text: "Download cancelled by user." }],
          details: { cancelled: true, planSummary },
          isError: false,
        };
      }

      const results: DownloadJobResult[] = [];
      for (const [index, job] of jobs.entries()) {
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Running job ${index + 1}/${jobs.length}: ${job.label}`,
            },
          ],
          details: {
            jobIndex: index,
            totalJobs: jobs.length,
            label: job.label,
          },
        });
        const execResult = await pi.exec("yt-dlp", job.args, {
          signal,
          cwd: ctx.cwd,
        });
        results.push({
          label: job.label,
          urlCount: job.urls.length,
          commandPreview: commandPreview("yt-dlp", job.args),
          code: execResult.code,
          stdout: execResult.stdout,
          stderr: execResult.stderr,
        });
      }

      const succeededUrls = jobs
        .filter((_job, index) => results[index]?.code === 0)
        .flatMap((job) => job.urls);
      const tracklists =
        params.tracklist === false || succeededUrls.length === 0
          ? { written: [], skipped: [] }
          : await writeBbcTracklists(
              pi,
              ctx.cwd,
              succeededUrls,
              destinationSelection.path,
              signal,
              (text) =>
                onUpdate?.({
                  content: [{ type: "text", text }],
                  details: { phase: "tracklist" },
                }),
            );

      let summary = summarizeResults(results, destinationSelection.path);
      if (tracklists.written.length > 0)
        summary += `\n\nTracklists written: ${tracklists.written.length}\n${tracklists.written
          .map((path) => `  ${basename(path)}`)
          .join("\n")}`;
      const hasFailure = results.some((result) => result.code !== 0);
      return {
        content: [{ type: "text", text: summary }],
        details: {
          mode,
          destinationPath: destinationSelection.path,
          audioFormat: selectedAudioFormat,
          videoContainer: selectedVideoContainer,
          playlistMode,
          overwriteMode,
          compatibilityProfile,
          cookiesFromBrowser,
          cookiesProfile,
          cookiesFile,
          continueOnErrors,
          playlistItems,
          sleepRequests,
          jobs: results,
          tracklists: tracklists.written,
        },
        isError: hasFailure,
      };
    },
  });

  pi.registerTool({
    name: "manage_media_discovery_rules",
    label: "Manage Media Discovery Rules",
    description:
      "Manage declarative, bounded per-site rules used to discover media entries from collection pages. This never downloads media.",
    promptSnippet: "Add, test, list, or remove generic media discovery rules",
    promptGuidelines: [
      "Use this when a collection page is not handled by yt-dlp, BBC, or RTVE discovery.",
      "Rules must be bounded regular expressions and only affect the configured domain.",
      "Discovery rules never download media; use download_media_with_ytdlp after selecting entries.",
    ],
    parameters: MediaDiscoveryRuleParamsSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [
            {
              type: "text",
              text: "Error: interactive UI is required to manage discovery rules.",
            },
          ],
          details: { reason: "no_ui" },
          isError: true,
        };
      }
      const action = params.action;
      if (action === "list") {
        const file = await loadDiscoveryRules();
        return {
          content: [
            {
              type: "text",
              text: `${DISCOVERY_RULES_FILE_PATH}\n${JSON.stringify(file, null, 2)}`,
            },
          ],
          details: file,
          isError: false,
        };
      }
      if (action === "remove") {
        const domain = params.domain?.trim().toLowerCase();
        const name = params.name?.trim();
        if (!domain && !name) {
          return {
            content: [
              {
                type: "text",
                text: "Error: provide domain or name when removing a discovery rule.",
              },
            ],
            details: { reason: "missing_remove_selector" },
            isError: true,
          };
        }
        const file = await loadDiscoveryRules();
        const remaining = file.rules.filter(
          (rule) =>
            (domain ? rule.domain !== domain : true) &&
            (name ? rule.name !== name : true),
        );
        if (remaining.length === file.rules.length) {
          return {
            content: [
              { type: "text", text: "No matching discovery rules were found." },
            ],
            details: { reason: "not_found", rules: file.rules },
            isError: false,
          };
        }
        const confirmed = await ctx.ui.confirm(
          "Remove media discovery rules?",
          `This will remove ${file.rules.length - remaining.length} rule(s).`,
        );
        if (!confirmed) {
          return {
            content: [
              { type: "text", text: "Discovery-rule removal cancelled." },
            ],
            details: { cancelled: true },
            isError: false,
          };
        }
        await saveDiscoveryRules(remaining);
        return {
          content: [
            {
              type: "text",
              text: `Removed ${file.rules.length - remaining.length} discovery rule(s).`,
            },
          ],
          details: { rules: remaining },
          isError: false,
        };
      }
      if (action === "add") {
        const rule = normalizeDiscoveryRule(params);
        if (!rule) {
          return {
            content: [
              {
                type: "text",
                text: "Error: add requires name, domain, entryPattern, and at least one URL/media field mapping.",
              },
            ],
            details: { reason: "invalid_rule" },
            isError: true,
          };
        }
        try {
          new RegExp(rule.entryPattern, "gi");
          for (const pattern of Object.values(rule.fields))
            new RegExp(pattern, "i");
          if (rule.urlPattern.startsWith("re:"))
            new RegExp(rule.urlPattern.slice(3), "i");
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error: invalid discovery-rule regular expression. ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            details: { reason: "invalid_regex" },
            isError: true,
          };
        }
        const confirmed = await ctx.ui.confirm(
          "Save media discovery rule?",
          JSON.stringify(rule, null, 2),
        );
        if (!confirmed) {
          return {
            content: [
              { type: "text", text: "Discovery-rule creation cancelled." },
            ],
            details: { cancelled: true },
            isError: false,
          };
        }
        const file = await loadDiscoveryRules();
        const rules = file.rules.filter(
          (item) => item.name !== rule.name && item.domain !== rule.domain,
        );
        rules.push(rule);
        await saveDiscoveryRules(rules);
        return {
          content: [
            {
              type: "text",
              text: `Saved discovery rule ${rule.name} for ${rule.domain}.`,
            },
          ],
          details: { rule, rules },
          isError: false,
        };
      }
      const testUrl = params.url?.trim();
      if (!testUrl) {
        return {
          content: [{ type: "text", text: "Error: test requires url." }],
          details: { reason: "missing_test_url" },
          isError: true,
        };
      }
      const file = await loadDiscoveryRules();
      const matching = file.rules.filter((rule) =>
        discoveryRuleMatchesUrl(testUrl, rule),
      );
      const html = await fetchMediaPageHtml(pi, ctx.cwd, testUrl, signal, {});
      const entries = extractConfiguredMediaEntries(
        html,
        testUrl,
        matching,
        MEDIA_PREVIEW_MAX_ENTRIES,
      );
      return {
        content: [
          {
            type: "text",
            text: `Matched ${matching.length} rule(s); extracted ${entries.length} media entr${entries.length === 1 ? "y" : "ies"}.\n${JSON.stringify(entries.slice(0, 10), null, 2)}`,
          },
        ],
        details: { url: testUrl, matchingRules: matching, entries },
        isError: false,
      };
    },
  });

  pi.registerTool({
    name: "inspect_media_capabilities",
    label: "Inspect Media Capabilities",
    description:
      "Inspect available local media tools: yt-dlp, ffmpeg, ffprobe, HandBrakeCLI, HandBrake GUI, and LosslessCut GUI.",
    promptSnippet:
      "Inspect installed media tooling before choosing FFmpeg, HandBrake, or LosslessCut.",
    promptGuidelines: [
      "Use this before recommending HandBrake or LosslessCut workflows.",
      "HandBrake GUI alone is not enough for automated batch conversion; automated HandBrake requires HandBrakeCLI.",
      "LosslessCut GUI is for manual visual edits; automated lossless edits should use FFmpeg stream copy.",
    ],
    parameters: MediaCapabilitiesParamsSchema,
    executionMode: "sequential",
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const capabilities = await inspectMediaCapabilities(pi, signal, ctx.cwd);
      return {
        content: [
          { type: "text", text: JSON.stringify(capabilities, null, 2) },
        ],
        details: capabilities,
        isError: false,
      };
    },
  });

  pi.registerTool({
    name: "transcode_videos_with_ffmpeg",
    label: "Transcode Videos",
    description:
      "Batch transcode local video files with FFmpeg using safe temp-file replacement. Use this for local file conversions, not downloads.",
    promptSnippet:
      "Transcode local video folders with FFmpeg using libx265, MP4 output, AC3-copy/AAC audio rules, dry-run preview, and safe replacement.",
    promptGuidelines: [
      "Use this tool for local video conversion/transcoding requests instead of generating ad-hoc shell loops.",
      "Default to dryRun=true unless the user explicitly asks to start execution immediately.",
      "For maximum Mac and LG TV compatibility, use profile='mac-lg-tv-h264'.",
      "For smaller files on modern LG TVs and Macs, use profile='lg-tv-hevc'.",
      "Use replaceOriginals=true only when the user explicitly requests replacement/deletion of originals.",
      "When exact original filename replacement is required, set outputNaming='same-path'. Warn that non-.mp4 extensions may then contain MP4 data.",
    ],
    parameters: TranscodeParamsSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params: TranscodeParams, signal, onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [
            {
              type: "text",
              text: "Error: interactive confirmation UI is required for this tool.",
            },
          ],
          details: { reason: "no_ui" },
          isError: true,
        };
      }

      const roots = Array.from(
        new Set(params.roots.map((root) => root.trim()).filter(Boolean)),
      );
      if (roots.length === 0) {
        return {
          content: [
            { type: "text", text: "Error: no root folders were provided." },
          ],
          details: { reason: "no_roots" },
          isError: true,
        };
      }

      for (const root of roots) {
        if (!isAbsolute(root)) {
          return {
            content: [
              {
                type: "text",
                text: `Error: root folder must be absolute: ${root}`,
              },
            ],
            details: { reason: "root_not_absolute", root },
            isError: true,
          };
        }
        try {
          const rootStat = await stat(root);
          if (!rootStat.isDirectory()) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: root path is not a folder: ${root}`,
                },
              ],
              details: { reason: "root_not_directory", root },
              isError: true,
            };
          }
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error: root folder is not accessible: ${root}\n${
                  error instanceof Error ? error.message : String(error)
                }`,
              },
            ],
            details: {
              reason: "root_not_accessible",
              root,
              error: error instanceof Error ? error.message : String(error),
            },
            isError: true,
          };
        }
      }

      const ffmpegCheck = await pi.exec("ffmpeg", ["-version"], {
        signal,
        cwd: ctx.cwd,
      });
      if (ffmpegCheck.code !== 0) {
        return {
          content: [
            { type: "text", text: "Error: ffmpeg is not available in PATH." },
          ],
          details: { reason: "missing_ffmpeg", stderr: ffmpegCheck.stderr },
          isError: true,
        };
      }

      const ffprobeCheck = await pi.exec("ffprobe", ["-version"], {
        signal,
        cwd: ctx.cwd,
      });
      if (ffprobeCheck.code !== 0) {
        return {
          content: [
            { type: "text", text: "Error: ffprobe is not available in PATH." },
          ],
          details: { reason: "missing_ffprobe", stderr: ffprobeCheck.stderr },
          isError: true,
        };
      }

      const recursive = params.recursive ?? true;
      const dryRun = params.dryRun ?? true;
      const replaceOriginals = params.replaceOriginals ?? false;
      const outputNaming: TranscodeOutputNaming =
        params.outputNaming ??
        (replaceOriginals ? "same-path" : "mp4-extension");
      const {
        engine,
        profile,
        videoCodec,
        crf,
        preset,
        audioMode,
        audioBitrate,
        audioChannels,
        handbrakePreset,
      } = resolveTranscodeSettings(params);

      if (engine === "handbrake") {
        const handbrakeCheck = await pi.exec("HandBrakeCLI", ["--version"], {
          signal,
          cwd: ctx.cwd,
        });
        if (handbrakeCheck.code !== 0) {
          return {
            content: [
              {
                type: "text",
                text: "Error: HandBrakeCLI is not available in PATH. The HandBrake GUI app may be installed, but automated batch conversion requires HandBrakeCLI.",
              },
            ],
            details: {
              reason: "missing_handbrake_cli",
              stderr: handbrakeCheck.stderr,
            },
            isError: true,
          };
        }
        if (!handbrakePreset) {
          return {
            content: [
              {
                type: "text",
                text: "Error: HandBrake engine requires a preset.",
              },
            ],
            details: { reason: "missing_handbrake_preset", profile },
            isError: true,
          };
        }
        const presetCheck = await handbrakePresetAvailable(
          pi,
          handbrakePreset,
          signal,
          ctx.cwd,
        );
        if (presetCheck.ok === false) {
          return {
            content: [
              {
                type: "text",
                text: `${presetCheck.error}${
                  presetCheck.availablePreview
                    ? `\n\nAvailable preset preview:\n${presetCheck.availablePreview}`
                    : ""
                }`,
              },
            ],
            details: {
              reason: "handbrake_preset_not_available",
              preset: handbrakePreset,
              presetCheck,
            },
            isError: true,
          };
        }
      }

      const files: string[] = [];
      for (const root of roots) {
        files.push(...(await scanVideoFiles(root, recursive)));
      }
      const uniqueFiles = Array.from(new Set(files)).sort((a, b) =>
        a.localeCompare(b),
      );

      if (uniqueFiles.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No video files found in the requested folders.",
            },
          ],
          details: { roots, recursive, found: 0 },
          isError: false,
        };
      }

      const plans: TranscodePlanItem[] = [];
      for (const inputPath of uniqueFiles) {
        const finalPath = buildTranscodeFinalPath(inputPath, outputNaming);
        const tempPath = buildTranscodeTempPath(finalPath);
        const audioCodec = await readAudioCodec(pi, inputPath, signal, ctx.cwd);
        if (engine === "handbrake") {
          const hbPreset = handbrakePreset ?? "Fast 1080p30";
          const args = buildHandBrakeArgs({
            inputPath,
            tempPath,
            preset: hbPreset,
          });
          plans.push({
            command: "HandBrakeCLI",
            inputPath,
            finalPath,
            tempPath,
            audioCodec,
            audioAction: "aac",
            handbrakePreset: hbPreset,
            args,
          });
        } else {
          const { args, audioAction } = buildTranscodeArgs({
            inputPath,
            tempPath,
            videoCodec,
            crf,
            preset,
            audioCodec,
            audioMode,
            audioBitrate,
            audioChannels,
          });
          plans.push({
            command: "ffmpeg",
            inputPath,
            finalPath,
            tempPath,
            audioCodec,
            audioAction,
            args,
          });
        }
      }

      const planSummary = summarizeTranscodePlan({
        roots,
        fileCount: plans.length,
        recursive,
        dryRun,
        replaceOriginals,
        outputNaming,
        engine,
        profile,
        videoCodec,
        handbrakePreset,
        crf,
        preset,
        audioMode,
        audioBitrate,
        audioChannels,
        previewItems: plans,
      });

      const confirmed = await ctx.ui.confirm(
        dryRun ? "Preview media transcode plan?" : "Run media transcode batch?",
        planSummary,
      );
      if (!confirmed) {
        return {
          content: [{ type: "text", text: "Transcode cancelled by user." }],
          details: { cancelled: true, planSummary },
          isError: false,
        };
      }

      if (dryRun) {
        return {
          content: [
            {
              type: "text",
              text: `Dry run complete. ${plans.length} video file(s) found.\n\n${planSummary}`,
            },
          ],
          details: { dryRun: true, roots, recursive, plans },
          isError: false,
        };
      }

      const results: TranscodeResult[] = [];
      for (const [index, item] of plans.entries()) {
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `Transcoding ${index + 1}/${plans.length}: ${item.inputPath}`,
            },
          ],
          details: { index, total: plans.length, inputPath: item.inputPath },
        });

        if (!replaceOriginals && (await pathExists(item.finalPath))) {
          results.push({
            command: item.command,
            inputPath: item.inputPath,
            finalPath: item.finalPath,
            tempPath: item.tempPath,
            audioCodec: item.audioCodec,
            audioAction: item.audioAction,
            handbrakePreset: item.handbrakePreset,
            commandPreview: commandPreview(item.command, item.args),
            code: 0,
            status: "skipped",
            error: `Output already exists: ${item.finalPath}`,
          });
          continue;
        }

        const execResult = await pi.exec(item.command, item.args, {
          signal,
          cwd: ctx.cwd,
        });
        if (execResult.code !== 0) {
          await rm(item.tempPath, { force: true });
          results.push({
            command: item.command,
            inputPath: item.inputPath,
            finalPath: item.finalPath,
            tempPath: item.tempPath,
            audioCodec: item.audioCodec,
            audioAction: item.audioAction,
            handbrakePreset: item.handbrakePreset,
            commandPreview: commandPreview(item.command, item.args),
            code: execResult.code,
            status: "failed",
            error: `${item.command} failed`,
            stdout: execResult.stdout,
            stderr: execResult.stderr,
          });
          continue;
        }

        try {
          const tempStat = await stat(item.tempPath);
          if (!tempStat.isFile() || tempStat.size <= 0) {
            await rm(item.tempPath, { force: true });
            results.push({
              command: item.command,
              inputPath: item.inputPath,
              finalPath: item.finalPath,
              tempPath: item.tempPath,
              audioCodec: item.audioCodec,
              audioAction: item.audioAction,
              handbrakePreset: item.handbrakePreset,
              commandPreview: commandPreview(item.command, item.args),
              code: 1,
              status: "failed",
              error: "Temporary output missing or empty after ffmpeg success",
            });
            continue;
          }

          if (replaceOriginals) {
            if (item.finalPath === item.inputPath) {
              const backupPath = `${item.inputPath}.pi-original-${Date.now()}-${randomUUID()}`;
              await rename(item.inputPath, backupPath);
              try {
                await rename(item.tempPath, item.finalPath);
                await rm(backupPath, { force: true });
              } catch (error) {
                await rename(backupPath, item.inputPath).catch(() => undefined);
                await rm(item.tempPath, { force: true });
                throw error;
              }
            } else {
              const finalBackupPath = `${item.finalPath}.pi-replaced-${Date.now()}-${randomUUID()}`;
              const finalExisted = await pathExists(item.finalPath);
              if (finalExisted) {
                await rename(item.finalPath, finalBackupPath);
              }
              try {
                await rename(item.tempPath, item.finalPath);
                await rm(item.inputPath, { force: true });
                if (finalExisted) {
                  await rm(finalBackupPath, { force: true });
                }
              } catch (error) {
                if (finalExisted) {
                  await rename(finalBackupPath, item.finalPath).catch(
                    () => undefined,
                  );
                }
                await rm(item.tempPath, { force: true });
                throw error;
              }
            }
          } else {
            await rename(item.tempPath, item.finalPath);
          }

          results.push({
            command: item.command,
            inputPath: item.inputPath,
            finalPath: item.finalPath,
            tempPath: item.tempPath,
            audioCodec: item.audioCodec,
            audioAction: item.audioAction,
            handbrakePreset: item.handbrakePreset,
            commandPreview: commandPreview(item.command, item.args),
            code: 0,
            status: "success",
            stdout: execResult.stdout,
            stderr: execResult.stderr,
          });
        } catch (error) {
          await rm(item.tempPath, { force: true });
          results.push({
            command: item.command,
            inputPath: item.inputPath,
            finalPath: item.finalPath,
            tempPath: item.tempPath,
            audioCodec: item.audioCodec,
            audioAction: item.audioAction,
            handbrakePreset: item.handbrakePreset,
            commandPreview: commandPreview(item.command, item.args),
            code: 1,
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const success = results.filter(
        (result) => result.status === "success",
      ).length;
      const skipped = results.filter(
        (result) => result.status === "skipped",
      ).length;
      const failed = results.filter(
        (result) => result.status === "failed",
      ).length;
      const lines = [
        `Transcode complete. Success: ${success}, Skipped: ${skipped}, Failed: ${failed}, Total: ${results.length}`,
      ];
      for (const result of results
        .filter((item) => item.status !== "success")
        .slice(0, 12)) {
        lines.push("");
        lines.push(`${result.status.toUpperCase()}: ${result.inputPath}`);
        lines.push(`Final: ${result.finalPath}`);
        if (result.error) lines.push(`Error: ${result.error}`);
        if (result.stderr?.trim())
          lines.push(`stderr:\n${result.stderr.trim().slice(0, 2000)}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          roots,
          recursive,
          dryRun,
          replaceOriginals,
          outputNaming,
          engine,
          profile,
          videoCodec,
          handbrakePreset,
          crf,
          preset,
          audioMode,
          audioBitrate,
          audioChannels,
          results,
        },
        isError: failed > 0,
      };
    },
  });

  pi.registerTool({
    name: "edit_media_losslessly",
    label: "Edit Media Losslessly",
    description:
      "Open media in LosslessCut for manual editing or perform automated lossless trim/remux/audio operations with FFmpeg stream copy.",
    promptSnippet:
      "Use LosslessCut for manual visual cuts, or FFmpeg -c copy for automated lossless trim/remux/extract/remove-audio.",
    promptGuidelines: [
      "Use mode='open-gui' with engine='losslesscut' when the user wants to inspect/cut manually.",
      "Use ffmpeg-copy for automated trims, remuxes, audio extraction, and audio removal.",
      "Default to dryRun=true for automated operations unless the user explicitly asks to execute.",
      "Lossless trim accuracy depends on keyframes; for frame-accurate cuts, use a transcode workflow.",
    ],
    parameters: LosslessEditParamsSchema,
    executionMode: "sequential",
    async execute(
      _toolCallId,
      params: LosslessEditParams,
      signal,
      _onUpdate,
      ctx,
    ) {
      const inputPath = params.input.trim();
      if (!isAbsolute(inputPath)) {
        return {
          content: [
            {
              type: "text",
              text: `Error: input path must be absolute: ${inputPath}`,
            },
          ],
          details: { reason: "input_not_absolute", inputPath },
          isError: true,
        };
      }
      if (!(await pathExists(inputPath))) {
        return {
          content: [
            {
              type: "text",
              text: `Error: input file does not exist: ${inputPath}`,
            },
          ],
          details: { reason: "input_missing", inputPath },
          isError: true,
        };
      }

      const mode = params.mode;
      const engine: LosslessEditEngine =
        params.engine && params.engine !== "auto"
          ? params.engine
          : mode === "open-gui"
            ? "losslesscut"
            : "ffmpeg-copy";
      const dryRun = params.dryRun ?? true;
      const replaceOutput = params.replaceOutput ?? false;

      if (engine === "losslesscut" || mode === "open-gui") {
        const appPath = await findApplicationBundle("LosslessCut");
        if (!appPath) {
          return {
            content: [
              {
                type: "text",
                text: "Error: LosslessCut.app was not found in /Applications or ~/Applications.",
              },
            ],
            details: { reason: "missing_losslesscut_gui" },
            isError: true,
          };
        }
        const args = ["-a", "LosslessCut", inputPath];
        const preview = commandPreview("open", args);
        if (dryRun) {
          return {
            content: [
              {
                type: "text",
                text: `Dry run: would open LosslessCut.\n${preview}`,
              },
            ],
            details: { dryRun, appPath, command: "open", args, preview },
            isError: false,
          };
        }
        const result = await pi.exec("open", args, { signal, cwd: ctx.cwd });
        return {
          content: [
            {
              type: "text",
              text:
                result.code === 0
                  ? `Opened in LosslessCut: ${inputPath}`
                  : `Failed to open LosslessCut.\n${result.stderr || result.stdout}`,
            },
          ],
          details: {
            appPath,
            command: "open",
            args,
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
          },
          isError: result.code !== 0,
        };
      }

      const ffmpegCheck = await pi.exec("ffmpeg", ["-version"], {
        signal,
        cwd: ctx.cwd,
      });
      if (ffmpegCheck.code !== 0) {
        return {
          content: [
            { type: "text", text: "Error: ffmpeg is not available in PATH." },
          ],
          details: { reason: "missing_ffmpeg", stderr: ffmpegCheck.stderr },
          isError: true,
        };
      }

      if (mode === "trim" && (!params.start?.trim() || !params.end?.trim())) {
        return {
          content: [
            {
              type: "text",
              text: "Error: mode=trim requires both start and end timestamps.",
            },
          ],
          details: { reason: "missing_trim_range" },
          isError: true,
        };
      }

      const container: LosslessOutputContainer =
        params.container ??
        (mode === "extract-audio"
          ? "m4a"
          : (extname(inputPath).replace(".", "") as LosslessOutputContainer) ||
            "mp4");
      const outputPath =
        params.output?.trim() ||
        defaultLosslessOutputPath(inputPath, mode, container);
      if (!isAbsolute(outputPath)) {
        return {
          content: [
            {
              type: "text",
              text: `Error: output path must be absolute: ${outputPath}`,
            },
          ],
          details: { reason: "output_not_absolute", outputPath },
          isError: true,
        };
      }
      if (!replaceOutput && (await pathExists(outputPath))) {
        return {
          content: [
            {
              type: "text",
              text: `Error: output already exists: ${outputPath}`,
            },
          ],
          details: { reason: "output_exists", outputPath },
          isError: true,
        };
      }

      const args = buildLosslessEditArgs({
        mode,
        inputPath,
        outputPath,
        start: params.start?.trim(),
        end: params.end?.trim(),
        replaceOutput,
      });
      const preview = commandPreview("ffmpeg", args);
      if (dryRun) {
        return {
          content: [
            {
              type: "text",
              text: `Dry run: would run lossless ${mode}.\n${preview}`,
            },
          ],
          details: {
            dryRun,
            mode,
            engine,
            inputPath,
            outputPath,
            command: "ffmpeg",
            args,
            preview,
          },
          isError: false,
        };
      }

      const confirmed = ctx.hasUI
        ? await ctx.ui.confirm(
            "Run lossless media edit?",
            `${mode}\nInput: ${inputPath}\nOutput: ${outputPath}\n${preview}`,
          )
        : false;
      if (!confirmed) {
        return {
          content: [{ type: "text", text: "Lossless edit cancelled by user." }],
          details: { cancelled: true, mode, inputPath, outputPath, preview },
          isError: false,
        };
      }

      const result = await pi.exec("ffmpeg", args, { signal, cwd: ctx.cwd });
      return {
        content: [
          {
            type: "text",
            text:
              result.code === 0
                ? `Lossless ${mode} complete: ${outputPath}`
                : `Lossless ${mode} failed.\n${result.stderr || result.stdout}`,
          },
        ],
        details: {
          mode,
          engine,
          inputPath,
          outputPath,
          command: "ffmpeg",
          args,
          code: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
        },
        isError: result.code !== 0,
      };
    },
  });

  pi.registerCommand("media-rule-add", {
    description:
      "Add a custom website date extraction rule for media filenames",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("UI is required for /media-rule-add", "warning");
        return;
      }

      const initialDomain = args.trim();
      const domainInput =
        initialDomain.length > 0
          ? initialDomain
          : ((
              await ctx.ui.input(
                "Rule domain",
                "example.com (without https://)",
              )
            )?.trim() ?? "");
      if (!domainInput) {
        ctx.ui.notify("Rule creation cancelled (missing domain).", "info");
        return;
      }

      const sampleUrl = (
        await ctx.ui.input(
          "Sample episode URL",
          "https://example.com/path/to/episode",
        )
      )?.trim();
      if (!sampleUrl) {
        ctx.ui.notify("Rule creation cancelled (missing sample URL).", "info");
        return;
      }

      const sourceChoice = await ctx.ui.select("Date source", [
        "HTML (recommended)",
        "URL text",
      ]);
      const source: "html" | "url" =
        sourceChoice === "URL text" ? "url" : "html";

      let sourceText = sampleUrl;
      if (source === "html") {
        const page = await pi.exec(
          "curl",
          ["-sL", "--max-time", "20", sampleUrl],
          { cwd: ctx.cwd },
        );
        if (page.code !== 0 || page.stdout.trim().length === 0) {
          ctx.ui.notify("Could not fetch page HTML for this URL.", "warning");
          return;
        }
        sourceText = page.stdout;
      }

      const candidates = makeRuleCandidates(source, sourceText);
      let selectedPattern = "";
      let previewDate = "";

      if (candidates.length > 0) {
        const selection = await ctx.ui.select("Detected date patterns", [
          ...candidates.map((candidate) => candidate.label),
          "Enter custom regex",
        ]);
        if (!selection) {
          ctx.ui.notify("Rule creation cancelled.", "info");
          return;
        }
        if (selection === "Enter custom regex") {
          const customPattern = (
            await ctx.ui.input(
              "Regex with capture group for date",
              'e.g. "emission":"(\\d{2}/\\d{2}/\\d{4})"',
            )
          )?.trim();
          if (!customPattern) {
            ctx.ui.notify("Rule creation cancelled (missing regex).", "info");
            return;
          }
          const extracted = tryExtractWithRegex(sourceText, customPattern);
          if (!extracted) {
            ctx.ui.notify(
              "Regex did not extract a valid date from sample data.",
              "warning",
            );
            return;
          }
          selectedPattern = customPattern;
          previewDate = extracted;
        } else {
          const candidate = candidates.find((item) => item.label === selection);
          if (!candidate) {
            ctx.ui.notify(
              "Rule creation cancelled (selection error).",
              "warning",
            );
            return;
          }
          selectedPattern = candidate.pattern;
          previewDate = candidate.value;
        }
      } else {
        const customPattern = (
          await ctx.ui.input(
            "No auto pattern found. Enter regex capture:",
            "e.g. (\\d{4}-\\d{2}-\\d{2})",
          )
        )?.trim();
        if (!customPattern) {
          ctx.ui.notify("Rule creation cancelled (missing regex).", "info");
          return;
        }
        const extracted = tryExtractWithRegex(sourceText, customPattern);
        if (!extracted) {
          ctx.ui.notify(
            "Regex did not extract a valid date from sample data.",
            "warning",
          );
          return;
        }
        selectedPattern = customPattern;
        previewDate = extracted;
      }

      const confirmation = await ctx.ui.confirm(
        "Save rule?",
        `Domain: ${domainInput}\nSource: ${source}\nPattern: ${selectedPattern}\nPreview date: ${previewDate}\nOutput format is always YYYY.MM.DD`,
      );
      if (!confirmation) {
        ctx.ui.notify("Rule creation cancelled.", "info");
        return;
      }

      const file = await loadRules();
      const filtered = file.rules.filter(
        (rule) => !(rule.domain === domainInput && rule.source === source),
      );
      filtered.push({ domain: domainInput, source, pattern: selectedPattern });
      await saveRulesFile({ version: 1, rules: filtered });
      ctx.ui.notify(`Rule saved for ${domainInput}.`, "info");
    },
  });

  pi.registerCommand("media-rule-test", {
    description: "Test custom date extraction rules against a URL",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("UI is required for /media-rule-test", "warning");
        return;
      }

      const testUrl =
        args.trim().length > 0
          ? args.trim()
          : ((
              await ctx.ui.input(
                "URL to test",
                "https://example.com/path/to/episode",
              )
            )?.trim() ?? "");
      if (!testUrl) {
        ctx.ui.notify("No URL provided.", "info");
        return;
      }

      const file = await loadRules();
      const matchingRules = file.rules.filter((rule) =>
        matchesDomain(testUrl, rule.domain),
      );
      if (matchingRules.length === 0) {
        ctx.ui.notify(`No custom rules configured for ${testUrl}.`, "info");
        return;
      }

      let html: string | undefined;
      if (matchingRules.some((rule) => rule.source === "html")) {
        const page = await pi.exec(
          "curl",
          ["-sL", "--max-time", "20", testUrl],
          { cwd: ctx.cwd },
        );
        if (page.code === 0 && page.stdout.trim().length > 0) {
          html = page.stdout;
        }
      }

      for (const rule of matchingRules) {
        const sourceText = rule.source === "url" ? testUrl : html;
        if (!sourceText) continue;
        const extracted = tryExtractWithRegex(sourceText, rule.pattern);
        if (!extracted) continue;
        ctx.ui.notify(
          `Matched ${rule.domain} (${rule.source}) → ${extracted}`,
          "info",
        );
        return;
      }

      ctx.ui.notify(
        "Rules matched domain but no valid date was extracted.",
        "warning",
      );
    },
  });

  pi.registerCommand("media-rule-list", {
    description: "List configured custom date extraction rules",
    handler: async (_args, ctx) => {
      const file = await loadRules();
      if (file.rules.length === 0) {
        ctx.ui.notify("No custom date rules configured.", "info");
        return;
      }
      const items = file.rules.map(
        (rule) => `${rule.domain} [${rule.source}] :: ${rule.pattern}`,
      );
      await ctx.ui.select(
        `Custom rules (${file.rules.length})\n${RULES_FILE_PATH}`,
        items,
      );
    },
  });

  pi.registerCommand("media-rule-remove", {
    description: "Remove custom date extraction rules for a domain",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("UI is required for /media-rule-remove", "warning");
        return;
      }

      const file = await loadRules();
      if (file.rules.length === 0) {
        ctx.ui.notify("No custom date rules configured.", "info");
        return;
      }

      let domain = args.trim();
      if (!domain) {
        const domains = Array.from(
          new Set(file.rules.map((rule) => rule.domain)),
        ).sort((a, b) => a.localeCompare(b));
        const selected = await ctx.ui.select(
          "Select domain to remove",
          domains,
        );
        domain = selected?.trim() ?? "";
      }

      if (!domain) {
        ctx.ui.notify("Rule removal cancelled.", "info");
        return;
      }

      const remaining = file.rules.filter((rule) => rule.domain !== domain);
      if (remaining.length === file.rules.length) {
        ctx.ui.notify(`No rules found for domain: ${domain}`, "warning");
        return;
      }

      const confirmed = await ctx.ui.confirm(
        `Remove rules for ${domain}?`,
        `This will remove ${file.rules.length - remaining.length} rule(s).`,
      );
      if (!confirmed) {
        ctx.ui.notify("Rule removal cancelled.", "info");
        return;
      }

      await saveRulesFile({ version: 1, rules: remaining });
      ctx.ui.notify(`Removed rules for ${domain}.`, "info");
    },
  });

  pi.registerCommand("mediarules", {
    description: "List, add, test, or remove generic media discovery rules",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("UI is required for /mediarules", "warning");
        return;
      }
      const action = args.trim().toLowerCase() || "list";
      if (action === "list") {
        const file = await loadDiscoveryRules();
        if (file.rules.length === 0) {
          ctx.ui.notify(
            `No generic media discovery rules configured.\n${DISCOVERY_RULES_FILE_PATH}`,
            "info",
          );
          return;
        }
        await ctx.ui.select(
          `Media discovery rules (${file.rules.length})`,
          file.rules.map((rule) => `${rule.name} — ${rule.domain}`),
        );
        return;
      }
      if (action === "remove") {
        const file = await loadDiscoveryRules();
        if (file.rules.length === 0) {
          ctx.ui.notify("No generic media discovery rules configured.", "info");
          return;
        }
        const selected = await ctx.ui.select(
          "Select discovery rule to remove",
          file.rules.map((rule) => `${rule.name} — ${rule.domain}`),
        );
        const index = selected
          ? file.rules.findIndex(
              (rule) => `${rule.name} — ${rule.domain}` === selected,
            )
          : -1;
        if (index < 0) return;
        const confirmed = await ctx.ui.confirm(
          "Remove discovery rule?",
          JSON.stringify(file.rules[index], null, 2),
        );
        if (!confirmed) return;
        file.rules.splice(index, 1);
        await saveDiscoveryRules(file.rules);
        ctx.ui.notify("Discovery rule removed.", "info");
        return;
      }
      if (action === "test") {
        const url = (
          await ctx.ui.input("URL to test", "https://example.com/collection")
        )?.trim();
        if (!url) return;
        const file = await loadDiscoveryRules();
        const matching = file.rules.filter((rule) =>
          discoveryRuleMatchesUrl(url, rule),
        );
        const html = await fetchMediaPageHtml(pi, ctx.cwd, url, undefined, {});
        const entries = extractConfiguredMediaEntries(
          html,
          url,
          matching,
          MEDIA_PREVIEW_MAX_ENTRIES,
        );
        const items = entries
          .slice(0, 50)
          .map((entry) =>
            String(
              entry.title ||
                entry.webpage_url ||
                entry.direct_url ||
                "Untitled",
            ),
          );
        await ctx.ui.select(
          `Extracted ${entries.length} entries`,
          items.length > 0 ? items : ["No entries"],
        );
        return;
      }
      if (action !== "add") {
        ctx.ui.notify(
          "Use /mediarules with list, add, test, or remove.",
          "warning",
        );
        return;
      }
      const name = (await ctx.ui.input("Rule name", "site-audio"))?.trim();
      const domain = (await ctx.ui.input("Rule domain", "example.com"))?.trim();
      const entryPattern = (
        await ctx.ui.input("Entry-block regex", "<article[\\s\\S]*?</article>")
      )?.trim();
      const urlPattern =
        (await ctx.ui.input("Optional URL pattern", ""))?.trim() || "";
      const urlField = (
        await ctx.ui.input(
          "Webpage URL capture regex",
          "href=[\\\"']([^\\\"']+)[\\\"']",
        )
      )?.trim();
      const titleField =
        (await ctx.ui.input("Title capture regex (optional)", ""))?.trim() ||
        "";
      if (!name || !domain || !entryPattern || !urlField) {
        ctx.ui.notify(
          "Rule creation cancelled: name, domain, entry regex, and URL regex are required.",
          "warning",
        );
        return;
      }
      const rule = normalizeDiscoveryRule({
        name,
        domain,
        urlPattern,
        entryPattern,
        fields: {
          webpageUrl: urlField,
          ...(titleField ? { title: titleField } : {}),
        },
      });
      if (!rule) {
        ctx.ui.notify("Invalid discovery rule.", "warning");
        return;
      }
      try {
        new RegExp(rule.entryPattern, "gi");
        for (const pattern of Object.values(rule.fields))
          new RegExp(pattern, "i");
      } catch (error) {
        ctx.ui.notify(
          `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
        return;
      }
      const confirmed = await ctx.ui.confirm(
        "Save discovery rule?",
        JSON.stringify(rule, null, 2),
      );
      if (!confirmed) return;
      const file = await loadDiscoveryRules();
      await saveDiscoveryRules([
        ...file.rules.filter(
          (item) => item.name !== rule.name && item.domain !== rule.domain,
        ),
        rule,
      ]);
      ctx.ui.notify(`Saved discovery rule ${rule.name}.`, "info");
    },
  });
}
