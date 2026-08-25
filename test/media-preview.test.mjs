import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function loadJiti() {
  const candidates = [
    process.env.PI_JITI_PATH,
    join(homedir(), ".pi/agent/npm/node_modules/jiti/lib/jiti.cjs"),
    join(
      homedir(),
      ".pi/agent/extensions/pi-kokoro/node_modules/jiti/lib/jiti.cjs",
    ),
  ].filter(Boolean);
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path)
    throw new Error(
      "Could not find Pi's jiti loader; set PI_JITI_PATH to jiti.cjs",
    );
  return createRequire(import.meta.url)(path).createJiti(import.meta.url, {
    moduleCache: false,
  });
}

const extensionPath = join(
  homedir(),
  ".pi/agent/extensions/yt-dlp-ffmpeg-extension/yt-dlp-ffmpeg.ts",
);
const testDestination = join(homedir(), "Downloads");

const genericHtml = `<!doctype html>
<main>
  <a href="/podcast/one">Episode One</a>
  <a href="/podcast/two" title="Episode Two">Episode Two</a>
</main>`;

const rtveHtml = `<li class="elem_" data-setup='{"idAsset":"123","tipo":"audio","title":"Test RTVE episode"}'>
  <span class="maintitle">Test RTVE episode</span>
  <span class="datemi"> 29/06/2026 </span>
  <span class="duration">00:59:52</span>
  <a class="goto_media" href="https://www.rtve.es/play/audios/test/test-29-06-26/123/">Listen</a>
  <span data-share="{&quot;file&quot;:&quot;https://ztnr.rtve.es/ztnr/123.mp3&quot;}"></span>
</li>`;

// Chrome that a real BBC episode page carries around the one item of interest.
const bbcEpisodeHtml = `<!doctype html>
<a href="#main-content">Skip to content</a>
<a href="#orb-modules">More menu</a>
<a href="#">Close menu</a>
<a href="/sounds/podcasts">Podcasts</a>
<a href="/programmes/m0008w2m">Night Tracks</a>
<a href="/programmes/m00302zq">Night Tracks, Nocturnal music to bewitch the senses</a>
<a href="/programmes/articles/contacts">BBC Radio Contacts &amp; Information</a>`;

const bbcSingleEpisodeJson = {
  id: "m00302zp",
  title: "Night Tracks, Sublime sounds for nightfall",
  duration: 5340,
  webpage_url: "https://www.bbc.co.uk/programmes/m00302zq",
  release_date: "20260824",
  formats: [{ format_id: "mf_akamai_nonbidi-audio_eng_1=48000-0", ext: "m4a" }],
};

const bbcEpisodeIndexJson = {
  _type: "playlist",
  id: "m0008w2m",
  title: "BBC Radio 3 - Night Tracks - Available now",
  entries: [
    { url: "http://www.bbc.co.uk/programmes/m003029l", title: "Episode A" },
    { url: "http://www.bbc.co.uk/programmes/m003038t", title: "Episode B" },
  ],
};

const bbcEpisodeUrls = [
  "https://www.bbc.co.uk/programmes/m00302zq",
  "https://www.bbc.co.uk/programmes/m002zsph",
  "https://www.bbc.co.uk/programmes/m002zsjf",
  "https://www.bbc.co.uk/programmes/m002ztfy",
  "https://www.bbc.co.uk/programmes/m002ztcb",
];

function makeHarness({
  html,
  selection,
  dumpJson,
  programmeKind,
  selectAnswer,
  confirmAnswer,
  segments,
  programmeMeta,
  downloadExit,
}) {
  const jiti = loadJiti();
  const extension = jiti(extensionPath);
  let downloadCalls = 0;
  let confirmation;
  let rendered = "";
  let tool;
  const probedUrls = [];
  const probeArgs = [];
  const downloadArgs = [];
  const prompts = [];
  const pi = {
    registerTool(candidate) {
      if (candidate.name === "download_media_with_ytdlp") tool = candidate;
    },
    registerCommand() {},
    async exec(command, args) {
      if (command === "yt-dlp" && args[0] === "--version")
        return { code: 0, stdout: "test", stderr: "" };
      if (command === "ffmpeg" && args[0] === "-version")
        return { code: 0, stdout: "test", stderr: "" };
      if (command === "curl") {
        const target = args[args.length - 1];
        const segMatch = target.match(/\/programmes\/([^/]+)\/segments\.json$/);
        if (segMatch) {
          const events = segments ? segments(segMatch[1]) : undefined;
          if (!events) return { code: 1, stdout: "", stderr: "not found" };
          return {
            code: 0,
            stdout: JSON.stringify({ segment_events: events }),
            stderr: "",
          };
        }
        if (target.endsWith(".json")) {
          const pid = target.split("/").pop().replace(".json", "");
          if (programmeMeta) {
            const meta = programmeMeta(pid);
            if (meta)
              return { code: 0, stdout: JSON.stringify(meta), stderr: "" };
          }
          const kind = programmeKind ? programmeKind(pid) : undefined;
          if (!kind) return { code: 1, stdout: "", stderr: "not found" };
          return {
            code: 0,
            stdout: JSON.stringify({ programme: { pid, type: kind } }),
            stderr: "",
          };
        }
        return { code: 0, stdout: html, stderr: "" };
      }
      if (command === "yt-dlp" && args.includes("--dump-single-json")) {
        probedUrls.push(args[args.length - 1]);
        probeArgs.push(args);
        const payload = dumpJson ? dumpJson(args[args.length - 1]) : undefined;
        if (payload)
          return { code: 0, stdout: JSON.stringify(payload), stderr: "" };
        return { code: 1, stdout: "", stderr: "ERROR: Unsupported URL" };
      }
      if (command === "yt-dlp") {
        downloadCalls += 1;
        downloadArgs.push(args);
        return { code: downloadExit ?? 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    },
  };
  extension.default(pi);

  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      async custom(factory) {
        let result = null;
        const done = (value) => {
          result = value;
        };
        const component = factory(
          { terminal: { rows: 20 }, requestRender() {} },
          { fg: (_colour, text) => text, bold: (text) => text },
          {},
          done,
        );
        rendered = component.render(140).join("\n");
        if (selection === "all") {
          component.handleInput("a");
          component.handleInput("\r");
        } else {
          component.handleInput("\u001b");
        }
        return result;
      },
      async confirm(title, message) {
        confirmation = { title, message };
        return confirmAnswer ?? false;
      },
      async select(title, options) {
        prompts.push({ title, options });
        return selectAnswer ? selectAnswer(title, options) : undefined;
      },
      async input() {
        return undefined;
      },
      notify() {},
    },
  };
  return {
    tool,
    ctx,
    getState: () => ({
      downloadCalls,
      confirmation,
      rendered,
      probedUrls,
      probeArgs,
      downloadArgs,
      prompts,
    }),
  };
}

test("media preview renders a plain selectable list and cancellation starts no download", async () => {
  const harness = makeHarness({ html: genericHtml, selection: "cancel" });
  const result = await harness.tool.execute(
    "test",
    {
      urls: ["https://example.test/podcasts/"],
      mode: "audio",
      preview: true,
      destinationPath: testDestination,
    },
    undefined,
    undefined,
    harness.ctx,
  );
  const state = harness.getState();
  assert.equal(result.content[0].text, "Download cancelled by user.");
  assert.equal(state.confirmation, undefined);
  assert.equal(state.downloadCalls, 0);
  assert.match(state.rendered, /Episode One/);
  assert.match(state.rendered, /Episode Two/);
  assert.doesNotMatch(state.rendered, /thumbnail|https:\/\//i);
});

test("selected entries use stable page URLs and still require download confirmation", async () => {
  const harness = makeHarness({ html: genericHtml, selection: "all" });
  const result = await harness.tool.execute(
    "test",
    {
      urls: ["https://example.test/podcasts/"],
      mode: "audio",
      preview: true,
      destinationPath: testDestination,
    },
    undefined,
    undefined,
    harness.ctx,
  );
  const state = harness.getState();
  assert.equal(result.content[0].text, "Download cancelled by user.");
  assert.equal(state.downloadCalls, 0);
  assert.ok(state.confirmation);
  assert.match(
    state.confirmation.message,
    /https:\/\/example\.test\/podcast\/one/,
  );
  assert.match(
    state.confirmation.message,
    /https:\/\/example\.test\/podcast\/two/,
  );
});

test("explicit playlistMode preserves ordinary whole-playlist behavior", async () => {
  const harness = makeHarness({ html: genericHtml, selection: "cancel" });
  const result = await harness.tool.execute(
    "test",
    {
      urls: ["https://www.youtube.com/playlist?list=example"],
      mode: "audio",
      playlistMode: "playlist",
      destinationPath: testDestination,
    },
    undefined,
    undefined,
    harness.ctx,
  );
  const state = harness.getState();
  assert.equal(result.content[0].text, "Download cancelled by user.");
  assert.equal(state.downloadCalls, 0);
  assert.ok(state.confirmation);
  assert.match(state.confirmation.message, /--yes-playlist/);
  assert.equal(state.rendered, "");
});

test("RTVE collection fallback supplies date, duration, and stable episode URL", async () => {
  const harness = makeHarness({ html: rtveHtml, selection: "cancel" });
  const result = await harness.tool.execute(
    "test",
    {
      urls: ["https://www.rtve.es/play/audios/test/"],
      mode: "audio",
      preview: true,
      destinationPath: testDestination,
    },
    undefined,
    undefined,
    harness.ctx,
  );
  const state = harness.getState();
  assert.equal(result.content[0].text, "Download cancelled by user.");
  assert.match(state.rendered, /Test RTVE episode/);
  assert.match(state.rendered, /2026\.06\.29/);
  assert.match(state.rendered, /59:52/);
});


test("a single BBC episode URL downloads directly, with no entry picker", async () => {
  const harness = makeHarness({
    html: bbcEpisodeHtml,
    selection: "cancel",
    dumpJson: () => bbcSingleEpisodeJson,
  });
  const result = await harness.tool.execute(
    "test",
    {
      urls: ["https://www.bbc.co.uk/programmes/m00302zq"],
      mode: "audio",
      audioFormat: "best",
      destinationPath: testDestination,
    },
    undefined,
    undefined,
    harness.ctx,
  );
  const state = harness.getState();
  assert.equal(result.content[0].text, "Download cancelled by user.");
  assert.equal(state.rendered, "");
  assert.ok(state.confirmation);
  assert.match(state.confirmation.message, /programmes\/m00302zq/);
  assert.match(state.confirmation.message, /--no-playlist/);
  assert.equal(state.downloadCalls, 0);
});

test("a bulk list of BBC episode URLs becomes one job with no entry picker", async () => {
  const harness = makeHarness({
    html: bbcEpisodeHtml,
    selection: "cancel",
    dumpJson: () => bbcSingleEpisodeJson,
  });
  await harness.tool.execute(
    "test",
    {
      urls: bbcEpisodeUrls,
      mode: "audio",
      audioFormat: "best",
      destinationPath: testDestination,
    },
    undefined,
    undefined,
    harness.ctx,
  );
  const state = harness.getState();
  assert.equal(state.rendered, "");
  assert.ok(state.confirmation);
  for (const url of bbcEpisodeUrls)
    assert.ok(
      state.confirmation.message.includes(url),
      `confirmation should mention ${url}`,
    );
});

test("forced preview of a resolvable episode lists that episode, not page navigation", async () => {
  const harness = makeHarness({
    html: bbcEpisodeHtml,
    selection: "cancel",
    dumpJson: () => bbcSingleEpisodeJson,
  });
  await harness.tool.execute(
    "test",
    {
      urls: ["https://www.bbc.co.uk/programmes/m00302zq"],
      mode: "audio",
      audioFormat: "best",
      preview: true,
      destinationPath: testDestination,
    },
    undefined,
    undefined,
    harness.ctx,
  );
  const state = harness.getState();
  assert.match(state.rendered, /Sublime sounds for nightfall/);
  assert.doesNotMatch(state.rendered, /Skip to content/);
  assert.doesNotMatch(state.rendered, /More menu|Close menu/);
  assert.doesNotMatch(state.rendered, /Contacts/);
  assert.match(state.rendered, /0\/1 selected/);
});

test("a BBC brand URL recovers through its episode index instead of scraping", async () => {
  const harness = makeHarness({
    html: bbcEpisodeHtml,
    selection: "cancel",
    dumpJson: (url) =>
      url.includes("/episodes/player") ? bbcEpisodeIndexJson : undefined,
  });
  await harness.tool.execute(
    "test",
    {
      urls: ["https://www.bbc.co.uk/programmes/m0008w2m"],
      mode: "audio",
      audioFormat: "best",
      preview: true,
      destinationPath: testDestination,
    },
    undefined,
    undefined,
    harness.ctx,
  );
  const state = harness.getState();
  assert.ok(
    state.probedUrls.includes(
      "https://www.bbc.co.uk/programmes/m0008w2m/episodes/player",
    ),
    "should retry the episode index",
  );
  assert.match(state.rendered, /Episode A/);
  assert.match(state.rendered, /Episode B/);
  assert.doesNotMatch(state.rendered, /Skip to content/);
});

test("scraped collections drop in-page anchors and site navigation links", async () => {
  const harness = makeHarness({
    html: `<a href="#main-content">Skip to content</a>
<a href="/podcasts">Podcasts</a>
<a href="/series">All series</a>
<a href="/podcast/real-episode">Real Episode</a>`,
    selection: "cancel",
  });
  await harness.tool.execute(
    "test",
    {
      urls: ["https://example.test/podcasts/"],
      mode: "audio",
      audioFormat: "best",
      preview: true,
      destinationPath: testDestination,
    },
    undefined,
    undefined,
    harness.ctx,
  );
  const state = harness.getState();
  assert.match(state.rendered, /Real Episode/);
  assert.doesNotMatch(state.rendered, /Skip to content/);
  assert.doesNotMatch(state.rendered, /Podcasts/);
  assert.doesNotMatch(state.rendered, /All series/);
});

test("playlist discovery caps entries with -I rather than legacy --playlist-end", async () => {
  const harness = makeHarness({
    html: bbcEpisodeHtml,
    selection: "cancel",
    dumpJson: (url) =>
      url.includes("/episodes/player") ? bbcEpisodeIndexJson : undefined,
  });
  await harness.tool.execute(
    "test",
    {
      urls: ["https://www.bbc.co.uk/programmes/m0008w2m/episodes/player"],
      mode: "audio",
      audioFormat: "best",
      maxPlaylistEntries: 25,
      destinationPath: testDestination,
    },
    undefined,
    undefined,
    harness.ctx,
  );
  const state = harness.getState();
  assert.equal(
    state.probeArgs.some((args) => args.includes("--playlist-end")),
    false,
    "must not use the legacy --playlist-end alias",
  );
  assert.ok(
    state.probeArgs.some((args) => args.join(" ").includes("-I :25")),
    "discovery should cap entries with -I :25",
  );
});


test("a BBC brand permalink is classified and expanded into its episode index", async () => {
  const brandUrl = "https://www.bbc.co.uk/programmes/m0008w2m";
  const harness = makeHarness({
    html: bbcEpisodeHtml,
    selection: "cancel",
    programmeKind: () => "brand",
    dumpJson: (url) =>
      url.includes("/episodes/player") ? bbcEpisodeIndexJson : undefined,
  });
  await harness.tool.execute(
    "test",
    {
      urls: [brandUrl],
      mode: "audio",
      audioFormat: "best",
      destinationPath: testDestination,
    },
    undefined,
    undefined,
    harness.ctx,
  );
  const state = harness.getState();
  assert.equal(state.probedUrls[0], `${brandUrl}/episodes/player`);
  assert.equal(
    state.probedUrls.includes(brandUrl),
    false,
    "the bare brand URL should never reach yt-dlp",
  );
  assert.match(state.rendered, /Episode A/);
  assert.match(state.rendered, /Episode B/);
});

test("a BBC episode permalink is classified as single and never reaches the picker", async () => {
  const harness = makeHarness({
    html: bbcEpisodeHtml,
    selection: "cancel",
    programmeKind: () => "episode",
    dumpJson: () => bbcSingleEpisodeJson,
  });
  await harness.tool.execute(
    "test",
    {
      urls: bbcEpisodeUrls,
      mode: "audio",
      audioFormat: "best",
      destinationPath: testDestination,
    },
    undefined,
    undefined,
    harness.ctx,
  );
  const state = harness.getState();
  assert.equal(state.rendered, "");
  assert.equal(
    state.probedUrls.length,
    0,
    "episode URLs need no discovery probe",
  );
  assert.ok(state.confirmation);
  for (const url of bbcEpisodeUrls)
    assert.ok(state.confirmation.message.includes(url));
});

test("an unreachable programme descriptor leaves the URL untouched", async () => {
  const harness = makeHarness({
    html: bbcEpisodeHtml,
    selection: "cancel",
    programmeKind: () => undefined,
    dumpJson: () => bbcSingleEpisodeJson,
  });
  await harness.tool.execute(
    "test",
    {
      urls: ["https://www.bbc.co.uk/programmes/m00302zq"],
      mode: "audio",
      audioFormat: "best",
      destinationPath: testDestination,
    },
    undefined,
    undefined,
    harness.ctx,
  );
  const state = harness.getState();
  assert.equal(state.rendered, "");
  assert.match(state.confirmation.message, /programmes\/m00302zq/);
  assert.doesNotMatch(state.confirmation.message, /episodes\/player/);
});


test("candidates from several URLs are numbered once and deduplicated", async () => {
  const shared = "https://www.bbc.co.uk/programmes/m003029l";
  const harness = makeHarness({
    html: bbcEpisodeHtml,
    selection: "cancel",
    programmeKind: () => "brand",
    dumpJson: (url) =>
      url.includes("/episodes/player")
        ? {
            _type: "playlist",
            id: "index",
            title: "Index",
            entries: [
              // http:// here vs https:// below: the same episode, spelled two ways.
              { url: shared.replace("https://", "http://"), title: "Shared Episode" },
              { url: `${shared}/`, title: "Shared Episode" },
              { url: "https://www.bbc.co.uk/programmes/m003038t", title: "Other" },
            ],
          }
        : undefined,
  });
  await harness.tool.execute(
    "test",
    {
      urls: [
        "https://www.bbc.co.uk/programmes/m0008w2m",
        "https://www.bbc.co.uk/programmes/m0008w2n",
      ],
      mode: "audio",
      audioFormat: "best",
      destinationPath: testDestination,
    },
    undefined,
    undefined,
    harness.ctx,
  );
  const state = harness.getState();
  const numbers = [...state.rendered.matchAll(/\[ \] (\d+)\./g)].map((m) =>
    Number(m[1]),
  );
  assert.deepEqual(
    numbers,
    numbers.map((_v, i) => i + 1),
    `entry numbers must be unique and sequential, got ${numbers.join(",")}`,
  );
  const sharedCount = (state.rendered.match(/Shared Episode/g) ?? []).length;
  assert.equal(sharedCount, 1, "a repeated episode should be listed once");
});


test("a model-chosen lossy format cannot proceed without the user saying so", async () => {
  const harness = makeHarness({
    html: bbcEpisodeHtml,
    selection: "cancel",
    programmeKind: () => "episode",
    dumpJson: () => bbcSingleEpisodeJson,
    // The user does not answer, which must not be read as consent.
    selectAnswer: () => undefined,
  });
  await harness.tool.execute(
    "test",
    {
      urls: ["https://www.bbc.co.uk/programmes/m002zd01"],
      mode: "audio",
      audioFormat: "mp3",
      destinationPath: testDestination,
    },
    undefined,
    undefined,
    harness.ctx,
  );
  const state = harness.getState();
  assert.ok(
    state.prompts.some((p) => /Convert this audio to mp3\?/.test(p.title)),
    "the user must be asked before any re-encode",
  );
  assert.match(state.confirmation.message, /Audio extension: best/);
  assert.doesNotMatch(state.confirmation.message, /--audio-format mp3/);
});

test("the user can still opt into a lossy format, and it is flagged", async () => {
  const harness = makeHarness({
    html: bbcEpisodeHtml,
    selection: "cancel",
    programmeKind: () => "episode",
    dumpJson: () => bbcSingleEpisodeJson,
    selectAnswer: (_title, options) =>
      options.find((o) => o.startsWith("Convert to")),
  });
  await harness.tool.execute(
    "test",
    {
      urls: ["https://www.bbc.co.uk/programmes/m002zd01"],
      mode: "audio",
      audioFormat: "mp3",
      destinationPath: testDestination,
    },
    undefined,
    undefined,
    harness.ctx,
  );
  const state = harness.getState();
  assert.match(state.confirmation.message, /Audio extension: mp3/);
  assert.match(state.confirmation.message, /WARNING: re-encodes lossy audio/);
});

test("the default audio path never prompts and never re-encodes", async () => {
  for (const audioFormat of [undefined, "best"]) {
    const harness = makeHarness({
      html: bbcEpisodeHtml,
      selection: "cancel",
      programmeKind: () => "episode",
      dumpJson: () => bbcSingleEpisodeJson,
    });
    await harness.tool.execute(
      "test",
      {
        urls: ["https://www.bbc.co.uk/programmes/m002zd01"],
        mode: "audio",
        ...(audioFormat ? { audioFormat } : {}),
        destinationPath: testDestination,
      },
      undefined,
      undefined,
      harness.ctx,
    );
    const state = harness.getState();
    assert.equal(
      state.prompts.length,
      0,
      `audioFormat=${audioFormat} should ask nothing`,
    );
    assert.match(state.confirmation.message, /Audio extension: best/);
    assert.doesNotMatch(state.confirmation.message, /WARNING/);
  }
});


test("a BBC Sounds play link is rewritten to the programme page yt-dlp supports", async () => {
  const harness = makeHarness({
    html: bbcEpisodeHtml,
    selection: "cancel",
    programmeKind: () => "episode",
    dumpJson: () => bbcSingleEpisodeJson,
  });
  await harness.tool.execute(
    "test",
    {
      urls: ["https://www.bbc.co.uk/sounds/play/m00302xq"],
      mode: "audio",
      destinationPath: testDestination,
    },
    undefined,
    undefined,
    harness.ctx,
  );
  const state = harness.getState();
  assert.match(
    state.confirmation.message,
    /https:\/\/www\.bbc\.co\.uk\/programmes\/m00302xq/,
  );
  assert.doesNotMatch(state.confirmation.message, /sounds\/play/);
  assert.equal(state.rendered, "", "still no entry picker for one episode");
});

test("a BBC Sounds link for a brand still expands into its episode index", async () => {
  const harness = makeHarness({
    html: bbcEpisodeHtml,
    selection: "cancel",
    programmeKind: () => "brand",
    dumpJson: (url) =>
      url.includes("/episodes/player") ? bbcEpisodeIndexJson : undefined,
  });
  await harness.tool.execute(
    "test",
    {
      urls: ["https://www.bbc.co.uk/sounds/play/m0008w2m"],
      mode: "audio",
      destinationPath: testDestination,
    },
    undefined,
    undefined,
    harness.ctx,
  );
  const state = harness.getState();
  assert.equal(
    state.probedUrls[0],
    "https://www.bbc.co.uk/programmes/m0008w2m/episodes/player",
  );
  assert.match(state.rendered, /Episode A/);
});


test("a Sounds link with no programme page is left exactly as given", async () => {
  const soundsOnly = "https://www.bbc.co.uk/sounds/play/p0abcdef";
  const harness = makeHarness({
    html: bbcEpisodeHtml,
    selection: "cancel",
    programmeKind: () => undefined, // no /programmes/<pid>.json for this pid
    dumpJson: () => bbcSingleEpisodeJson,
  });
  await harness.tool.execute(
    "test",
    { urls: [soundsOnly], mode: "audio", destinationPath: testDestination },
    undefined,
    undefined,
    harness.ctx,
  );
  const state = harness.getState();
  assert.ok(state.confirmation.message.includes(soundsOnly));
  assert.doesNotMatch(state.confirmation.message, /programmes\/p0abcdef/);
});


test("a BBC Sounds brand URL expands into the episode index", async () => {
  const harness = makeHarness({
    html: bbcEpisodeHtml,
    selection: "cancel",
    programmeKind: () => "brand",
    dumpJson: (url) =>
      url.includes("/episodes/player") ? bbcEpisodeIndexJson : undefined,
  });
  await harness.tool.execute(
    "test",
    {
      urls: ["https://www.bbc.co.uk/sounds/brand/m0008w2m"],
      mode: "audio",
      destinationPath: testDestination,
    },
    undefined,
    undefined,
    harness.ctx,
  );
  const state = harness.getState();
  assert.equal(
    state.probedUrls[0],
    "https://www.bbc.co.uk/programmes/m0008w2m/episodes/player",
  );
  assert.equal(
    state.probedUrls.some((u) => u.includes("/sounds/")),
    false,
    "no /sounds/ URL may reach yt-dlp",
  );
  assert.match(state.rendered, /Episode A/);
});


// --- tracklist written beside the audio -----------------------------------

const trackMeta = (pid) => ({
  programme: {
    pid,
    type: "episode",
    title: "Harmonious music for nighttime listening",
    first_broadcast_date: "2026-08-17T22:00:00+01:00",
    ownership: { service: { title: "BBC Radio 3" } },
    parent: { programme: { title: "Night Tracks", type: "brand" } },
  },
});

const musicSegments = () => [
  {
    position: 1,
    version_offset: 0,
    segment: {
      type: "music",
      artist: "F.S. Blumm",
      track_title: "Di Lei",
      release_title: "Torre",
      record_label: "Leiter",
    },
  },
  {
    position: 2,
    version_offset: 3906,
    segment: {
      type: "music",
      artist: "Ola Gjeilo",
      track_title: "Northern Lights",
      release_title: "Reverence for the Moment",
      record_label: "VCM Records",
    },
  },
];

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "ytdlp-audit-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const EPISODE_URL = "https://www.bbc.co.uk/programmes/m00302xq";

test("a completed download writes the tracklist beside the audio", async () => {
  await withTempDir(async (dir) => {
    const harness = makeHarness({
      html: bbcEpisodeHtml,
      selection: "cancel",
      confirmAnswer: true,
      programmeMeta: trackMeta,
      segments: musicSegments,
      dumpJson: () => bbcSingleEpisodeJson,
    });
    const result = await harness.tool.execute(
      "test",
      { urls: [EPISODE_URL], mode: "audio", destinationPath: dir },
      undefined,
      undefined,
      harness.ctx,
    );
    const files = await readdir(dir);
    assert.deepEqual(files, [
      "2026.08.17 — Night Tracks, Harmonious music for nighttime listening.md",
    ]);
    assert.match(result.content[0].text, /Tracklists written: 1/);

    const body = await readFile(join(dir, files[0]), "utf8");
    assert.match(body, /^# Night Tracks — Harmonious music for nighttime listening$/m);
    assert.match(body, /\*\*Broadcast\*\* 2026-08-17/);
    assert.match(body, /## Tracklist \(2\)/);
    // version_offset 3906s must render as 1:05:06, not 3906 or 65:06.
    assert.match(body, /\| 2 \| 1:05:06 \| Ola Gjeilo \| Northern Lights \|/);
    assert.match(body, /\| 1 \| 0:00 \| F\.S\. Blumm \| Di Lei \| Torre \| Leiter \|/);
  });
});

test("tracklist:false writes no markdown", async () => {
  await withTempDir(async (dir) => {
    const harness = makeHarness({
      html: bbcEpisodeHtml,
      selection: "cancel",
      confirmAnswer: true,
      programmeMeta: trackMeta,
      segments: musicSegments,
      dumpJson: () => bbcSingleEpisodeJson,
    });
    const result = await harness.tool.execute(
      "test",
      {
        urls: [EPISODE_URL],
        mode: "audio",
        destinationPath: dir,
        tracklist: false,
      },
      undefined,
      undefined,
      harness.ctx,
    );
    assert.deepEqual(await readdir(dir), []);
    assert.doesNotMatch(result.content[0].text, /Tracklists written/);
  });
});

test("a failed download writes no tracklist", async () => {
  await withTempDir(async (dir) => {
    const harness = makeHarness({
      html: bbcEpisodeHtml,
      selection: "cancel",
      confirmAnswer: true,
      downloadExit: 1,
      programmeMeta: trackMeta,
      segments: musicSegments,
      dumpJson: () => bbcSingleEpisodeJson,
    });
    await harness.tool.execute(
      "test",
      { urls: [EPISODE_URL], mode: "audio", destinationPath: dir },
      undefined,
      undefined,
      harness.ctx,
    );
    assert.deepEqual(
      await readdir(dir),
      [],
      "nothing downloaded, so nothing to annotate",
    );
  });
});

test("a programme with no music segments produces no empty file", async () => {
  await withTempDir(async (dir) => {
    const harness = makeHarness({
      html: bbcEpisodeHtml,
      selection: "cancel",
      confirmAnswer: true,
      programmeMeta: trackMeta,
      segments: () => [{ position: 1, segment: { type: "speech" } }],
      dumpJson: () => bbcSingleEpisodeJson,
    });
    await harness.tool.execute(
      "test",
      { urls: [EPISODE_URL], mode: "audio", destinationPath: dir },
      undefined,
      undefined,
      harness.ctx,
    );
    assert.deepEqual(await readdir(dir), []);
  });
});
