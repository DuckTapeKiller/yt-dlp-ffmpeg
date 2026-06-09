import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { type Static, StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const AUDIO_FORMATS = ["best", "aac", "alac", "flac", "m4a", "mp3", "opus", "vorbis", "wav"] as const;
const VIDEO_CONTAINERS = ["mkv", "mp4", "webm", "mov"] as const;
const PLAYLIST_MODES = ["single", "playlist"] as const;
const OVERWRITE_MODES = ["skip", "overwrite"] as const;
const COOKIE_BROWSERS = ["none", "safari", "chrome", "chromium", "firefox", "edge", "brave", "vivaldi"] as const;
const DOWNLOAD_COMPATIBILITY_PROFILES = ["source", "mac-lg-tv"] as const;
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
const LOSSLESS_EDIT_MODES = ["open-gui", "trim", "remux", "extract-audio", "remove-audio"] as const;
const LOSSLESS_EDIT_ENGINES = ["auto", "ffmpeg-copy", "losslesscut"] as const;
const LOSSLESS_OUTPUT_CONTAINERS = ["mp4", "mkv", "mov", "m4a", "aac", "mp3"] as const;
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
	urls: Type.Array(Type.String({ description: "One or more media URLs to download" }), {
		minItems: 1,
		description: "List of URLs to download",
	}),
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
	audioFormat: Type.Optional(
		StringEnum(AUDIO_FORMATS, {
			description: "Audio extension for extraction when mode=audio. Omit to choose interactively",
		}),
	),
	videoContainer: Type.Optional(
		StringEnum(VIDEO_CONTAINERS, {
			description: "Final video container when mode=video. Omit to choose interactively",
		}),
	),
	playlistMode: Type.Optional(
		StringEnum(PLAYLIST_MODES, {
			description: "How to handle playlist URLs. Omit to choose interactively when playlist URLs are detected",
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
			description: "Absolute path to a Netscape cookies.txt file to pass with --cookies.",
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
			description: "Optional yt-dlp playlist item spec, e.g. '1-10', '1,3,5', or '10:20'.",
		}),
	),
	sleepRequests: Type.Optional(
		Type.Number({
			minimum: 0,
			description: "Optional delay in seconds between yt-dlp HTTP requests. Useful for YouTube rate/captcha pressure.",
		}),
	),
	compatibilityProfile: Type.Optional(
		StringEnum(DOWNLOAD_COMPATIBILITY_PROFILES, {
			description:
				"Download compatibility profile. Defaults to mac-lg-tv for video. source keeps best available source behavior.",
		}),
	),
});

const TranscodeParamsSchema = Type.Object({
	roots: Type.Array(Type.String({ description: "Absolute folder paths to scan for video files" }), {
		minItems: 1,
		description: "One or more root folders containing videos to transcode",
	}),
	recursive: Type.Optional(
		Type.Boolean({
			description: "Scan subfolders recursively. Defaults to true.",
		}),
	),
	dryRun: Type.Optional(
		Type.Boolean({
			description: "Preview files and commands without transcoding. Defaults to true.",
		}),
	),
	replaceOriginals: Type.Optional(
		Type.Boolean({
			description: "Replace originals after successful transcode. Requires confirmation. Defaults to false.",
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
			description: "libx265 preset, e.g. medium, slow, slower. Defaults to medium.",
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
		description: "Lossless edit operation. open-gui opens LosslessCut; other modes use FFmpeg stream copy.",
	}),
	engine: Type.Optional(
		StringEnum(LOSSLESS_EDIT_ENGINES, {
			description: "Execution engine. auto uses LosslessCut for open-gui and ffmpeg-copy otherwise.",
		}),
	),
	output: Type.Optional(
		Type.String({
			description: "Absolute output path for trim/remux/extract/remove operations.",
		}),
	),
	start: Type.Optional(
		Type.String({
			description: "Trim start timestamp, e.g. 00:01:20. Required for mode=trim.",
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
type DownloadCompatibilityProfile = NonNullable<DownloadParams["compatibilityProfile"]>;
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

const RULES_FILE_PATH = join(homedir(), ".pi", "agent", "extensions", "yt-dlp-ffmpeg.rules.json");

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
			hostname.endsWith("bbc.co.uk") && (pathname.includes("/programmes/") || pathname.includes("/sounds/play/"))
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
	const titleMatch = segment.match(/title="(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})"/i);
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
	const lastOnBlockMatch = html.match(/<h2>\s*Last on\s*<\/h2>[\s\S]{0,12000}/i);
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

	const ariaLabelMatch = html.match(/Fecha de emisión:[^"]*(\d{2}\/\d{2}\/\d{4})/i);
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

	const dayMonthNamePattern = value.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
	if (dayMonthNamePattern) {
		const month = monthNameToNumber(dayMonthNamePattern[2]);
		if (month) {
			return `${dayMonthNamePattern[3]}.${month}.${dayMonthNamePattern[1].padStart(2, "0")}`;
		}
	}

	return undefined;
}

function tryExtractWithRegex(sourceText: string, pattern: string): string | undefined {
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

function makeRuleCandidates(source: "html" | "url", sourceText: string): RuleMatchCandidate[] {
	const presets: Array<{ label: string; pattern: string }> =
		source === "html"
			? [
					{ label: "JSON emission field", pattern: '"emission":"(\\d{2}/\\d{2}/\\d{4})"' },
					{ label: "HTML datetime content", pattern: 'content="(\\d{4}-\\d{2}-\\d{2})T[^"]*"' },
					{ label: "datemi span", pattern: 'class="datemi"[^>]*>(\\d{2}/\\d{2}/\\d{4})<' },
					{ label: "ISO date in page", pattern: "\\b(\\d{4}-\\d{2}-\\d{2})\\b" },
					{ label: "Slash date in page", pattern: "\\b(\\d{2}/\\d{2}/\\d{4})\\b" },
				]
			: [
					{ label: "dd-mm-yy in URL", pattern: "/(\\d{2}-\\d{2}-\\d{2})(?:/|$)" },
					{ label: "yyyy-mm-dd in URL", pattern: "/(\\d{4}-\\d{2}-\\d{2})(?:/|$)" },
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
				rules.push({ domain: rule.domain, source: rule.source, pattern: rule.pattern });
			}
		}
		return { version: 1, rules };
	} catch {
		return { version: 1, rules: [] };
	}
}

async function saveRulesFile(file: RulesFile): Promise<void> {
	await mkdir(join(homedir(), ".pi", "agent", "extensions"), { recursive: true });
	const serialized = `${JSON.stringify(file, null, 2)}\n`;
	await writeFile(RULES_FILE_PATH, serialized, "utf8");
}

function matchesDomain(url: string, domain: string): boolean {
	try {
		const hostname = new URL(url).hostname.toLowerCase();
		const normalizedDomain = domain.trim().toLowerCase();
		if (!normalizedDomain) return false;
		return hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`);
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

async function ensureWritableDirectory(path: string): Promise<{ ok: true } | { ok: false; error: string }> {
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
				error: error instanceof Error ? error.message : "Unable to access destination folder",
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
			error: (result.stderr || result.stdout || `exit code ${result.code}`).trim().slice(0, 500),
		};
	}
	const version = (result.stdout || result.stderr).trim().split("\n")[0]?.trim();
	return { available: true, version };
}

async function findApplicationBundle(appName: string): Promise<string | undefined> {
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
	const [ffmpeg, ffprobe, ytDlp, handbrakeCli, handbrakeApp, losslessCutApp] = await Promise.all([
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
		losslessCutGui: { available: Boolean(losslessCutApp), path: losslessCutApp },
		recommendations: {
			downloads: ytDlp.available ? "download_media_with_ytdlp" : "install yt-dlp",
			batchTranscode: handbrakeCli.available
				? "transcode_videos_with_ffmpeg with engine=ffmpeg or engine=handbrake"
				: "transcode_videos_with_ffmpeg with engine=ffmpeg",
			manualTrimming: losslessCutApp ? "edit_media_losslessly mode=open-gui" : "ffmpeg-copy trim/remux",
			macLgTvDefault: "MP4 container, H.264 video, AAC audio",
		},
	};
}

function isHiddenPathSegment(path: string): boolean {
	return path
		.split("/")
		.some((segment) => segment.length > 0 && segment.startsWith(".") && segment !== "." && segment !== "..");
}

function isVideoFile(path: string): boolean {
	return VIDEO_EXTENSIONS.has(extname(path).toLowerCase()) && !isHiddenPathSegment(path);
}

async function scanVideoFiles(root: string, recursive: boolean): Promise<string[]> {
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

async function readAudioCodec(pi: ExtensionAPI, inputPath: string, signal: AbortSignal | undefined, cwd: string) {
	const result = await pi.exec(
		"ffprobe",
		["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "json", inputPath],
		{ signal, cwd },
	);
	if (result.code !== 0) return undefined;
	try {
		const parsed = JSON.parse(result.stdout) as { streams?: Array<{ codec_name?: string }> };
		return parsed.streams?.[0]?.codec_name?.toLowerCase();
	} catch {
		return undefined;
	}
}

function buildTranscodeFinalPath(inputPath: string, outputNaming: TranscodeOutputNaming): string {
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
		requestedEngine === "auto" ? (profile.startsWith("handbrake-") ? "handbrake" : "ffmpeg") : requestedEngine;
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
	return ["--input", options.inputPath, "--output", options.tempPath, "--preset", options.preset];
}

async function handbrakePresetAvailable(
	pi: ExtensionAPI,
	preset: string,
	signal: AbortSignal | undefined,
	cwd: string,
): Promise<{ ok: true } | { ok: false; error: string; availablePreview?: string }> {
	const result = await pi.exec("HandBrakeCLI", ["--preset-list"], { signal, cwd });
	if (result.code !== 0) {
		return {
			ok: false,
			error: (result.stderr || result.stdout || "HandBrakeCLI preset list failed").trim().slice(0, 800),
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
		args.push("-c:v", options.videoCodec, "-crf", String(options.crf), "-preset", options.preset);
	}

	let audioAction: "copy" | "aac" | "none" = "none";
	if (options.audioCodec) {
		if (options.audioMode === "copy" || (options.audioMode === "copy-ac3-else-aac" && options.audioCodec === "ac3")) {
			audioAction = "copy";
			args.push("-c:a", "copy");
		} else {
			audioAction = "aac";
			args.push("-c:a", "aac", "-b:a", options.audioBitrate, "-ac", String(options.audioChannels));
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
		if (item.handbrakePreset) lines.push(`  HandBrake preset: ${item.handbrakePreset}`);
		lines.push(`  ${commandPreview(item.command, item.args)}`);
	}
	if (options.fileCount > options.previewItems.length) {
		lines.push(`... ${options.fileCount - options.previewItems.length} more file(s)`);
	}
	return lines.join("\n");
}

function defaultLosslessOutputPath(inputPath: string, mode: LosslessEditMode, container: LosslessOutputContainer): string {
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
			args.push("-i", options.inputPath, "-map", "0", "-c", "copy", options.outputPath);
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
			return ["-hide_banner", "-nostdin", ...overwriteArgs, "-i", options.inputPath, "-map", "0", "-c", "copy", options.outputPath];
	}
}

async function chooseMode(ui: PickerUI, initialMode: DownloadParams["mode"]): Promise<DownloadMode> {
	if (initialMode) return initialMode;
	const choice = await ui.select("Download type", ["Audio", "Video"]);
	if (choice === "Video") return "video";
	return "audio";
}

async function chooseAudioFormat(ui: PickerUI, initial: DownloadParams["audioFormat"]): Promise<AudioFormat> {
	if (initial) return initial;
	const options = [
		"Use default: best (keeps best available source audio; extension may vary)",
		"mp3",
		"m4a",
		"opus",
		"flac",
		"wav",
		"aac",
		"vorbis",
		"alac",
	];
	const selection = await ui.select("Audio extension", options);
	if (!selection || selection.startsWith("Use default:")) return "best";
	return selection as AudioFormat;
}

async function chooseVideoContainer(ui: PickerUI, initial: DownloadParams["videoContainer"]): Promise<VideoContainer> {
	if (initial) return initial;
	const options = ["Use default: mkv (best stream preservation; may not open in QuickTime/iOS)", "mp4", "webm", "mov"];
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
	const selection = await ui.select("Playlist behavior", ["Single item only (default)", "Full playlist"]);
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

function selectDestinationPath(destinationPath: string | undefined): { path: string; source: "default" | "custom" } {
	if (destinationPath && destinationPath.trim().length > 0) {
		const trimmed = destinationPath.trim();
		// Expand ~ to the real home directory so the model can pass ~/Downloads/... naturally.
		const expanded = trimmed === "~" ? homedir() : trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed;
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

function buildOutputTemplateWithFixedDate(destinationPath: string, date: string): string {
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
		sharedArgs.push("-x", "--audio-quality", "0", "--audio-format", audioFormat ?? "best");
	} else if (compatibilityProfile === "mac-lg-tv") {
		sharedArgs.push(
			"-f",
			"bv*[ext=mp4][vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4][vcodec^=avc1]/best[ext=mp4]/best",
			"--merge-output-format",
			"mp4",
		);
	} else {
		sharedArgs.push("-f", "bv*+ba/b", "--merge-output-format", videoContainer ?? "mkv");
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

	if (typeof sleepRequests === "number" && Number.isFinite(sleepRequests) && sleepRequests > 0) {
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
		const singleUrls = urlsWithoutOverride.filter((url) => !isLikelyPlaylistUrl(url));
		const mixed = playlistUrls.length > 0 && singleUrls.length > 0;

		if (!mixed) {
			const allArePlaylistLike = playlistUrls.length === urlsWithoutOverride.length;
			const playlistFlag = allArePlaylistLike && playlistMode === "playlist" ? "--yes-playlist" : "--no-playlist";
			jobs.push({
				label: allArePlaylistLike ? "playlist URLs" : "single URLs",
				urls: urlsWithoutOverride,
				args: [...sharedArgs, "--output", outputTemplate, playlistFlag, ...urlsWithoutOverride],
			});
		} else {
			if (singleUrls.length > 0) {
				jobs.push({
					label: "single URLs",
					urls: singleUrls,
					args: [...sharedArgs, "--output", outputTemplate, "--no-playlist", ...singleUrls],
				});
			}
			if (playlistUrls.length > 0) {
				const playlistFlag = playlistMode === "playlist" ? "--yes-playlist" : "--no-playlist";
				jobs.push({
					label: "playlist-like URLs",
					urls: playlistUrls,
					args: [...sharedArgs, "--output", outputTemplate, playlistFlag, ...playlistUrls],
				});
			}
		}
	}

	for (const url of urlsWithOverride) {
		const forcedDate = dateOverrides.get(url);
		if (!forcedDate) continue;
		const playlistFlag = isLikelyPlaylistUrl(url) && playlistMode === "playlist" ? "--yes-playlist" : "--no-playlist";
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
	lines.push(`Destination: ${options.destinationPath} (${options.destinationSource})`);
	if (options.mode === "audio") {
		lines.push(`Audio extension: ${options.audioFormat ?? "best"}${options.audioFormat ? "" : " (default)"}`);
	} else if (options.compatibilityProfile === "mac-lg-tv") {
		lines.push("Video profile: mac-lg-tv (prefer MP4/H.264 video + M4A/AAC audio)");
	} else {
		lines.push(`Video container: ${options.videoContainer ?? "mkv"}${options.videoContainer ? "" : " (default)"}`);
	}
	lines.push(`Compatibility profile: ${options.compatibilityProfile}`);
	lines.push(`Playlist mode: ${options.playlistMode}`);
	lines.push(`Overwrite mode: ${options.overwriteMode}`);
	lines.push(`Continue on item errors: ${options.continueOnErrors ? "yes" : "no"}`);
	if (options.playlistItems?.trim()) {
		lines.push(`Playlist items: ${options.playlistItems.trim()}`);
	}
	if (typeof options.sleepRequests === "number" && options.sleepRequests > 0) {
		lines.push(`Sleep between requests: ${options.sleepRequests}s`);
	}
	if (options.cookiesFile?.trim()) {
		lines.push(`Cookies: file ${options.cookiesFile.trim()}`);
	} else if (options.cookiesFromBrowser && options.cookiesFromBrowser !== "none") {
		lines.push(
			`Cookies: ${options.cookiesFromBrowser}${options.cookiesProfile?.trim() ? ` profile ${options.cookiesProfile.trim()}` : ""}`,
		);
	} else {
		lines.push("Cookies: none");
	}
	lines.push(`Jobs: ${options.jobs.length}`);
	for (const [index, job] of options.jobs.entries()) {
		lines.push(`  ${index + 1}. ${job.label} (${job.urls.length} URL${job.urls.length === 1 ? "" : "s"})`);
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

function summarizeResults(results: DownloadJobResult[], destinationPath: string): string {
	const successful = results.filter((result) => result.code === 0).length;
	const failed = results.length - successful;
	const lines: string[] = [];
	lines.push(`Download completed. Success: ${successful}/${results.length}, Failed: ${failed}/${results.length}`);
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
		promptSnippet: "Download audio/video with yt-dlp + ffmpeg to a user-selected destination",
		promptGuidelines: [
			"Use this tool for media download requests instead of generating raw yt-dlp commands.",
			"Provide all user URLs in one call whenever possible.",
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
					content: [{ type: "text", text: "Error: interactive confirmation UI is required for this tool." }],
					details: { reason: "no_ui" },
					isError: true,
				};
			}

			const urls = dedupeUrls(params.urls);
			if (urls.length === 0) {
				return {
					content: [{ type: "text", text: "Error: no valid URLs were provided." }],
					details: { reason: "no_urls" },
					isError: true,
				};
			}

			const mode = await chooseMode(ctx.ui, params.mode);
			const compatibilityProfile: DownloadCompatibilityProfile =
				params.compatibilityProfile ?? (mode === "video" ? "mac-lg-tv" : "source");
			const selectedAudioFormat = mode === "audio" ? await chooseAudioFormat(ctx.ui, params.audioFormat) : undefined;
			const selectedVideoContainer =
				mode === "video"
					? compatibilityProfile === "mac-lg-tv"
						? "mp4"
						: await chooseVideoContainer(ctx.ui, params.videoContainer)
					: undefined;
			const hasPlaylistUrls = urls.some(isLikelyPlaylistUrl);
			const playlistMode = await choosePlaylistMode(ctx.ui, params.playlistMode, hasPlaylistUrls);
			const overwriteMode: OverwriteMode = params.overwriteMode ?? "skip";
			const continueOnErrors = params.continueOnErrors ?? playlistMode === "playlist";
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

			const destinationSelection = selectDestinationPath(params.destinationPath);
			if (!isAbsolute(destinationSelection.path)) {
				return {
					content: [
						{ type: "text", text: `Error: destination path must be absolute: ${destinationSelection.path}` },
					],
					details: { reason: "destination_not_absolute", destinationPath: destinationSelection.path },
					isError: true,
				};
			}

			if (cookiesFile && !isAbsolute(cookiesFile)) {
				return {
					content: [{ type: "text", text: `Error: cookies file path must be absolute: ${cookiesFile}` }],
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

			const destinationCheck = await ensureWritableDirectory(destinationSelection.path);
			if (!destinationCheck.ok) {
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

			const ytDlpCheck = await pi.exec("yt-dlp", ["--version"], { signal, cwd: ctx.cwd });
			if (ytDlpCheck.code !== 0) {
				return {
					content: [{ type: "text", text: "Error: yt-dlp is not available in PATH." }],
					details: { reason: "missing_yt_dlp", stderr: ytDlpCheck.stderr },
					isError: true,
				};
			}

			const ffmpegCheck = await pi.exec("ffmpeg", ["-version"], { signal, cwd: ctx.cwd });
			if (ffmpegCheck.code !== 0) {
				return {
					content: [{ type: "text", text: "Error: ffmpeg is not available in PATH." }],
					details: { reason: "missing_ffmpeg", stderr: ffmpegCheck.stderr },
					isError: true,
				};
			}

			const customRules = await loadRules();
			const dateOverrides = new Map<string, string>();
			for (const url of urls) {
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
					const pageResult = await pi.exec("curl", ["-sL", "--max-time", "20", url], { signal, cwd: ctx.cwd });
					if (pageResult.code === 0 && pageResult.stdout.trim().length > 0) {
						pageHtml = pageResult.stdout;
					}
				}

				const customDate = await extractDateFromCustomRules(url, pageHtml, customRules.rules);
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
				urls,
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
			const confirmed = await ctx.ui.confirm("Run yt-dlp download?", planSummary);
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
					content: [{ type: "text", text: `Running job ${index + 1}/${jobs.length}: ${job.label}` }],
					details: { jobIndex: index, totalJobs: jobs.length, label: job.label },
				});
				const execResult = await pi.exec("yt-dlp", job.args, { signal, cwd: ctx.cwd });
				results.push({
					label: job.label,
					urlCount: job.urls.length,
					commandPreview: commandPreview("yt-dlp", job.args),
					code: execResult.code,
					stdout: execResult.stdout,
					stderr: execResult.stderr,
				});
			}

			const summary = summarizeResults(results, destinationSelection.path);
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
				},
				isError: hasFailure,
			};
		},
	});

	pi.registerTool({
		name: "inspect_media_capabilities",
		label: "Inspect Media Capabilities",
		description:
			"Inspect available local media tools: yt-dlp, ffmpeg, ffprobe, HandBrakeCLI, HandBrake GUI, and LosslessCut GUI.",
		promptSnippet: "Inspect installed media tooling before choosing FFmpeg, HandBrake, or LosslessCut.",
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
				content: [{ type: "text", text: JSON.stringify(capabilities, null, 2) }],
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
					content: [{ type: "text", text: "Error: interactive confirmation UI is required for this tool." }],
					details: { reason: "no_ui" },
					isError: true,
				};
			}

			const roots = Array.from(new Set(params.roots.map((root) => root.trim()).filter(Boolean)));
			if (roots.length === 0) {
				return {
					content: [{ type: "text", text: "Error: no root folders were provided." }],
					details: { reason: "no_roots" },
					isError: true,
				};
			}

			for (const root of roots) {
				if (!isAbsolute(root)) {
					return {
						content: [{ type: "text", text: `Error: root folder must be absolute: ${root}` }],
						details: { reason: "root_not_absolute", root },
						isError: true,
					};
				}
				try {
					const rootStat = await stat(root);
					if (!rootStat.isDirectory()) {
						return {
							content: [{ type: "text", text: `Error: root path is not a folder: ${root}` }],
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
						details: { reason: "root_not_accessible", root, error: error instanceof Error ? error.message : String(error) },
						isError: true,
					};
				}
			}

			const ffmpegCheck = await pi.exec("ffmpeg", ["-version"], { signal, cwd: ctx.cwd });
			if (ffmpegCheck.code !== 0) {
				return {
					content: [{ type: "text", text: "Error: ffmpeg is not available in PATH." }],
					details: { reason: "missing_ffmpeg", stderr: ffmpegCheck.stderr },
					isError: true,
				};
			}

			const ffprobeCheck = await pi.exec("ffprobe", ["-version"], { signal, cwd: ctx.cwd });
			if (ffprobeCheck.code !== 0) {
				return {
					content: [{ type: "text", text: "Error: ffprobe is not available in PATH." }],
					details: { reason: "missing_ffprobe", stderr: ffprobeCheck.stderr },
					isError: true,
				};
			}

			const recursive = params.recursive ?? true;
			const dryRun = params.dryRun ?? true;
			const replaceOriginals = params.replaceOriginals ?? false;
			const outputNaming: TranscodeOutputNaming =
				params.outputNaming ?? (replaceOriginals ? "same-path" : "mp4-extension");
			const { engine, profile, videoCodec, crf, preset, audioMode, audioBitrate, audioChannels, handbrakePreset } =
				resolveTranscodeSettings(params);

			if (engine === "handbrake") {
				const handbrakeCheck = await pi.exec("HandBrakeCLI", ["--version"], { signal, cwd: ctx.cwd });
				if (handbrakeCheck.code !== 0) {
					return {
						content: [
							{
								type: "text",
								text:
									"Error: HandBrakeCLI is not available in PATH. The HandBrake GUI app may be installed, but automated batch conversion requires HandBrakeCLI.",
							},
						],
						details: { reason: "missing_handbrake_cli", stderr: handbrakeCheck.stderr },
						isError: true,
					};
				}
				if (!handbrakePreset) {
					return {
						content: [{ type: "text", text: "Error: HandBrake engine requires a preset." }],
						details: { reason: "missing_handbrake_preset", profile },
						isError: true,
					};
				}
				const presetCheck = await handbrakePresetAvailable(pi, handbrakePreset, signal, ctx.cwd);
				if (!presetCheck.ok) {
					return {
						content: [
							{
								type: "text",
								text: `${presetCheck.error}${
									presetCheck.availablePreview ? `\n\nAvailable preset preview:\n${presetCheck.availablePreview}` : ""
								}`,
							},
						],
						details: { reason: "handbrake_preset_not_available", preset: handbrakePreset, presetCheck },
						isError: true,
					};
				}
			}

			const files: string[] = [];
			for (const root of roots) {
				files.push(...(await scanVideoFiles(root, recursive)));
			}
			const uniqueFiles = Array.from(new Set(files)).sort((a, b) => a.localeCompare(b));

			if (uniqueFiles.length === 0) {
				return {
					content: [{ type: "text", text: "No video files found in the requested folders." }],
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
					const args = buildHandBrakeArgs({ inputPath, tempPath, preset: hbPreset });
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
					plans.push({ command: "ffmpeg", inputPath, finalPath, tempPath, audioCodec, audioAction, args });
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
					content: [{ type: "text", text: `Dry run complete. ${plans.length} video file(s) found.\n\n${planSummary}` }],
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

				const execResult = await pi.exec(item.command, item.args, { signal, cwd: ctx.cwd });
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
									await rename(finalBackupPath, item.finalPath).catch(() => undefined);
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

			const success = results.filter((result) => result.status === "success").length;
			const skipped = results.filter((result) => result.status === "skipped").length;
			const failed = results.filter((result) => result.status === "failed").length;
			const lines = [
				`Transcode complete. Success: ${success}, Skipped: ${skipped}, Failed: ${failed}, Total: ${results.length}`,
			];
			for (const result of results.filter((item) => item.status !== "success").slice(0, 12)) {
				lines.push("");
				lines.push(`${result.status.toUpperCase()}: ${result.inputPath}`);
				lines.push(`Final: ${result.finalPath}`);
				if (result.error) lines.push(`Error: ${result.error}`);
				if (result.stderr?.trim()) lines.push(`stderr:\n${result.stderr.trim().slice(0, 2000)}`);
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
		async execute(_toolCallId, params: LosslessEditParams, signal, _onUpdate, ctx) {
			const inputPath = params.input.trim();
			if (!isAbsolute(inputPath)) {
				return {
					content: [{ type: "text", text: `Error: input path must be absolute: ${inputPath}` }],
					details: { reason: "input_not_absolute", inputPath },
					isError: true,
				};
			}
			if (!(await pathExists(inputPath))) {
				return {
					content: [{ type: "text", text: `Error: input file does not exist: ${inputPath}` }],
					details: { reason: "input_missing", inputPath },
					isError: true,
				};
			}

			const mode = params.mode;
			const engine: LosslessEditEngine =
				params.engine && params.engine !== "auto" ? params.engine : mode === "open-gui" ? "losslesscut" : "ffmpeg-copy";
			const dryRun = params.dryRun ?? true;
			const replaceOutput = params.replaceOutput ?? false;

			if (engine === "losslesscut" || mode === "open-gui") {
				const appPath = await findApplicationBundle("LosslessCut");
				if (!appPath) {
					return {
						content: [{ type: "text", text: "Error: LosslessCut.app was not found in /Applications or ~/Applications." }],
						details: { reason: "missing_losslesscut_gui" },
						isError: true,
					};
				}
				const args = ["-a", "LosslessCut", inputPath];
				const preview = commandPreview("open", args);
				if (dryRun) {
					return {
						content: [{ type: "text", text: `Dry run: would open LosslessCut.\n${preview}` }],
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
					details: { appPath, command: "open", args, code: result.code, stdout: result.stdout, stderr: result.stderr },
					isError: result.code !== 0,
				};
			}

			const ffmpegCheck = await pi.exec("ffmpeg", ["-version"], { signal, cwd: ctx.cwd });
			if (ffmpegCheck.code !== 0) {
				return {
					content: [{ type: "text", text: "Error: ffmpeg is not available in PATH." }],
					details: { reason: "missing_ffmpeg", stderr: ffmpegCheck.stderr },
					isError: true,
				};
			}

			if (mode === "trim" && (!params.start?.trim() || !params.end?.trim())) {
				return {
					content: [{ type: "text", text: "Error: mode=trim requires both start and end timestamps." }],
					details: { reason: "missing_trim_range" },
					isError: true,
				};
			}

			const container: LosslessOutputContainer =
				params.container ?? (mode === "extract-audio" ? "m4a" : (extname(inputPath).replace(".", "") as LosslessOutputContainer) || "mp4");
			const outputPath = params.output?.trim() || defaultLosslessOutputPath(inputPath, mode, container);
			if (!isAbsolute(outputPath)) {
				return {
					content: [{ type: "text", text: `Error: output path must be absolute: ${outputPath}` }],
					details: { reason: "output_not_absolute", outputPath },
					isError: true,
				};
			}
			if (!replaceOutput && (await pathExists(outputPath))) {
				return {
					content: [{ type: "text", text: `Error: output already exists: ${outputPath}` }],
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
					content: [{ type: "text", text: `Dry run: would run lossless ${mode}.\n${preview}` }],
					details: { dryRun, mode, engine, inputPath, outputPath, command: "ffmpeg", args, preview },
					isError: false,
				};
			}

			const confirmed = ctx.hasUI
				? await ctx.ui.confirm("Run lossless media edit?", `${mode}\nInput: ${inputPath}\nOutput: ${outputPath}\n${preview}`)
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
				details: { mode, engine, inputPath, outputPath, command: "ffmpeg", args, code: result.code, stdout: result.stdout, stderr: result.stderr },
				isError: result.code !== 0,
			};
		},
	});

	pi.registerCommand("media-rule-add", {
		description: "Add a custom website date extraction rule for media filenames",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("UI is required for /media-rule-add", "warning");
				return;
			}

			const initialDomain = args.trim();
			const domainInput =
				initialDomain.length > 0
					? initialDomain
					: ((await ctx.ui.input("Rule domain", "example.com (without https://)"))?.trim() ?? "");
			if (!domainInput) {
				ctx.ui.notify("Rule creation cancelled (missing domain).", "info");
				return;
			}

			const sampleUrl = (await ctx.ui.input("Sample episode URL", "https://example.com/path/to/episode"))?.trim();
			if (!sampleUrl) {
				ctx.ui.notify("Rule creation cancelled (missing sample URL).", "info");
				return;
			}

			const sourceChoice = await ctx.ui.select("Date source", ["HTML (recommended)", "URL text"]);
			const source: "html" | "url" = sourceChoice === "URL text" ? "url" : "html";

			let sourceText = sampleUrl;
			if (source === "html") {
				const page = await pi.exec("curl", ["-sL", "--max-time", "20", sampleUrl], { cwd: ctx.cwd });
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
						await ctx.ui.input("Regex with capture group for date", 'e.g. "emission":"(\\d{2}/\\d{2}/\\d{4})"')
					)?.trim();
					if (!customPattern) {
						ctx.ui.notify("Rule creation cancelled (missing regex).", "info");
						return;
					}
					const extracted = tryExtractWithRegex(sourceText, customPattern);
					if (!extracted) {
						ctx.ui.notify("Regex did not extract a valid date from sample data.", "warning");
						return;
					}
					selectedPattern = customPattern;
					previewDate = extracted;
				} else {
					const candidate = candidates.find((item) => item.label === selection);
					if (!candidate) {
						ctx.ui.notify("Rule creation cancelled (selection error).", "warning");
						return;
					}
					selectedPattern = candidate.pattern;
					previewDate = candidate.value;
				}
			} else {
				const customPattern = (
					await ctx.ui.input("No auto pattern found. Enter regex capture:", "e.g. (\\d{4}-\\d{2}-\\d{2})")
				)?.trim();
				if (!customPattern) {
					ctx.ui.notify("Rule creation cancelled (missing regex).", "info");
					return;
				}
				const extracted = tryExtractWithRegex(sourceText, customPattern);
				if (!extracted) {
					ctx.ui.notify("Regex did not extract a valid date from sample data.", "warning");
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
			const filtered = file.rules.filter((rule) => !(rule.domain === domainInput && rule.source === source));
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
					: ((await ctx.ui.input("URL to test", "https://example.com/path/to/episode"))?.trim() ?? "");
			if (!testUrl) {
				ctx.ui.notify("No URL provided.", "info");
				return;
			}

			const file = await loadRules();
			const matchingRules = file.rules.filter((rule) => matchesDomain(testUrl, rule.domain));
			if (matchingRules.length === 0) {
				ctx.ui.notify(`No custom rules configured for ${testUrl}.`, "info");
				return;
			}

			let html: string | undefined;
			if (matchingRules.some((rule) => rule.source === "html")) {
				const page = await pi.exec("curl", ["-sL", "--max-time", "20", testUrl], { cwd: ctx.cwd });
				if (page.code === 0 && page.stdout.trim().length > 0) {
					html = page.stdout;
				}
			}

			for (const rule of matchingRules) {
				const sourceText = rule.source === "url" ? testUrl : html;
				if (!sourceText) continue;
				const extracted = tryExtractWithRegex(sourceText, rule.pattern);
				if (!extracted) continue;
				ctx.ui.notify(`Matched ${rule.domain} (${rule.source}) → ${extracted}`, "info");
				return;
			}

			ctx.ui.notify("Rules matched domain but no valid date was extracted.", "warning");
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
			const items = file.rules.map((rule) => `${rule.domain} [${rule.source}] :: ${rule.pattern}`);
			await ctx.ui.select(`Custom rules (${file.rules.length})\n${RULES_FILE_PATH}`, items);
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
				const domains = Array.from(new Set(file.rules.map((rule) => rule.domain))).sort((a, b) =>
					a.localeCompare(b),
				);
				const selected = await ctx.ui.select("Select domain to remove", domains);
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
}
