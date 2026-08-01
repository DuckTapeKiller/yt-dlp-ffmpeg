import assert from "node:assert/strict";
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

function makeHarness({ html, selection }) {
  const jiti = loadJiti();
  const extension = jiti(extensionPath);
  let downloadCalls = 0;
  let confirmation;
  let rendered = "";
  let tool;
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
      if (command === "curl") return { code: 0, stdout: html, stderr: "" };
      if (command === "yt-dlp" && args.includes("--dump-single-json")) {
        return { code: 1, stdout: "", stderr: "ERROR: Unsupported URL" };
      }
      if (command === "yt-dlp") {
        downloadCalls += 1;
        return { code: 0, stdout: "", stderr: "" };
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
        return false;
      },
      async select() {
        return undefined;
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
    getState: () => ({ downloadCalls, confirmation, rendered }),
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
