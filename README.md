# yt-dlp-ffmpeg Pi Package

This folder is a local Pi package for guided media download workflows.

## Package Layout

- `package.json` declares the Pi package metadata.
- `index.ts` is the package entrypoint Pi loads.
- `yt-dlp-ffmpeg.ts` contains the extension implementation.

## What it does

- Adds a `download_media_with_ytdlp` tool for audio/video downloads.
- Adds a `transcode_videos_with_ffmpeg` tool for local video/audio conversions.
- Adds an `inspect_media_capabilities` tool for checking FFmpeg, ffprobe, yt-dlp, HandBrake, and LosslessCut availability.
- Adds an `edit_media_losslessly` tool for LosslessCut GUI opening and FFmpeg stream-copy trim/remux/audio operations.
- Provides a guided audio/video download flow.
- Adds safe confirmation before execution.
- Adds Mac/LG TV compatibility profiles for online downloads and local transcodes.
- Supports browser cookies/cookies.txt for YouTube login, consent, captcha, and age-gated sessions.
- Continues playlist downloads past individual failed items by default.
- Supports playlist item ranges and request throttling.
- Adds selectable, list-only media previews for playlists, series, episode lists, feeds, and collection pages. Previewing never downloads media.
- Automatically previews list-like URLs when `playlistMode` is omitted and also supports `preview: true` for an explicit preview request.
- Shows title, date, duration, availability, and selection state without rendering thumbnails.
- Downloads only the explicitly selected stable entry URLs, then keeps the normal Pi confirmation step before yt-dlp runs.
- Supports up to 500 preview entries by default; set `maxPlaylistEntries` to use a smaller bound.
- Keeps dedicated BBC and RTVE handling ahead of generic discovery, including BBC broadcast-date and RTVE emission-date filename fallbacks.
- Adds generic JSON-LD, RSS/Atom, HTML-link, and configurable per-domain discovery extraction.
- Adds declarative discovery-rule management via the `manage_media_discovery_rules` tool and `/mediarules` command. Rules are stored in `~/.pi/agent/extensions/yt-dlp-ffmpeg.discovery-rules.json` and support `list`, `add`, `test`, and `remove`.
- Adds BBC/RTVE date fallback naming.
- Adds custom website date rules via:
  - `/media-rule-add`
  - `/media-rule-test`
  - `/media-rule-list`
  - `/media-rule-remove`

## Requirements

- `yt-dlp` must be installed and available on the `PATH` used to launch Pi.
- `ffmpeg` must be installed and available on the `PATH` used to launch Pi.
- `ffprobe` must be installed and available on the same `PATH`.
- `HandBrakeCLI` is required for automated HandBrake batch conversion. The HandBrake GUI alone can be opened manually but cannot run automated batches.
- `LosslessCut.app` is used for manual visual cutting. Automated lossless edits use FFmpeg stream copy.

## Use

This package currently lives in `~/.pi/agent/extensions/yt-dlp-ffmpeg-extension`,
so Pi auto-discovers it through `index.ts`.

If you move it out of the auto-discovery folder, install it as a local package:

```bash
pi install ~/.pi/agent/extensions/yt-dlp-ffmpeg-extension
```

## YouTube playlists that need authentication

For YouTube URLs, the tool asks whether to use browser cookies before running yt-dlp. The first option is `No cookies`; choose the browser where YouTube is already logged in when authentication, captcha, age, or consent state is needed.

If YouTube reports captcha, login, age, consent, or "blocked from display on this website or application", retry from a browser profile where the video plays normally.

Example Pi tool parameters:

```json
{
  "urls": ["https://www.youtube.com/playlist?list=..."],
  "preview": true,
  "maxPlaylistEntries": 100,
  "mode": "video",
  "videoContainer": "mp4",
  "playlistMode": "playlist",
  "cookiesFromBrowser": "safari",
  "continueOnErrors": true,
  "sleepRequests": 1
}
```

For a list-like URL, the preview is automatic. In the list, use Up/Down to move, Space to toggle, `a` to select all, `n` to clear all, Enter to continue to the normal download confirmation, and Escape to cancel.

Use `"chrome"`, `"firefox"`, `"brave"`, etc. instead of `"safari"` if that is where you are logged into YouTube. If a browser profile is locked, close the browser and retry. If a rightsholder blocks playback even in the browser, cookies cannot bypass that.

## Generic discovery rules

Use `/mediarules list` to inspect configured rules, `/mediarules add` to create one interactively, `/mediarules test` to test a page, and `/mediarules remove` to delete one. The structured tool accepts the same actions:

```json
{
  "action": "add",
  "name": "example-audio",
  "domain": "example.com",
  "urlPattern": "re:/podcasts/",
  "entryPattern": "<article\\b[^>]*>([\\s\\S]*?)</article>",
  "fields": {
    "webpageUrl": "href=[\\\"']([^\\\"']+)[\\\"']",
    "title": "<h2[^>]*>([\\s\\S]*?)</h2>"
  }
}
```

`entryPattern` and field patterns are bounded regular expressions. Capture group 1 supplies each value. Rules are limited to their configured domain and are used only for discovery; they never initiate a download.

## Mac + LG TV compatibility

Video downloads default to Mac + LG TV compatibility. The tool prefers MP4/H.264 video plus M4A/AAC audio unless you explicitly set `compatibilityProfile` to `source`.

Default video behavior:

```json
{
  "compatibilityProfile": "mac-lg-tv",
  "mode": "video",
  "videoContainer": "mp4"
}
```

This makes yt-dlp prefer MP4/H.264 video plus M4A/AAC audio streams. It avoids re-encoding where possible and gives the best quality available inside the compatible stream set.

Use source/best format only when compatibility does not matter:

```json
{
  "compatibilityProfile": "source"
}
```

For local conversions, use:

```json
{
  "roots": ["/absolute/folder"],
  "profile": "mac-lg-tv-h264",
  "dryRun": true
}
```

Profiles:

- `mac-lg-tv-h264`: safest MP4/H.264/AAC target for Mac QuickTime and LG TVs.
- `lg-tv-hevc`: MP4/H.265/HEVC target for newer LG TVs and Macs, smaller than H.264.
- `hevc-archive`: H.265/HEVC CRF 23 with AC3 copy when possible.
- `custom`: explicit codec/audio options.

Replacement mode is transaction-safe: FFmpeg writes a temp file in the same folder, verifies it is non-empty, then replaces only after success. Failed files clean up their temp output and the batch continues.

## Capability detection

```json
{
  "tool": "inspect_media_capabilities"
}
```

Use this before deciding whether to recommend FFmpeg, HandBrakeCLI, HandBrake GUI, or LosslessCut.

## HandBrake engine

`transcode_videos_with_ffmpeg` can use either FFmpeg or HandBrakeCLI:

```json
{
  "roots": ["/absolute/folder"],
  "engine": "handbrake",
  "profile": "handbrake-hq-1080p30",
  "dryRun": true
}
```

HandBrake profiles:

- `handbrake-fast-1080p30`
- `handbrake-hq-1080p30`
- `handbrake-hq-2160p60-4k-hevc`
- `handbrake-apple-compatible`
- `handbrake-lg-tv-compatible`

If a preset is not installed under that exact name, pass `handbrakePreset` explicitly after checking `HandBrakeCLI --preset-list`.

## Lossless editing

Open a file in LosslessCut:

```json
{
  "input": "/absolute/video.mp4",
  "mode": "open-gui",
  "engine": "losslesscut",
  "dryRun": false
}
```

Automated lossless trim:

```json
{
  "input": "/absolute/video.mp4",
  "mode": "trim",
  "start": "00:02:00",
  "end": "00:18:30",
  "output": "/absolute/video.trim.mp4",
  "engine": "ffmpeg-copy",
  "dryRun": true
}
```

Other automated modes:

- `remux`
- `extract-audio`
- `remove-audio`

These use FFmpeg stream copy, so they are fast and avoid quality loss. Trim cuts may be keyframe-bound; use a transcode workflow for frame-accurate cuts.
