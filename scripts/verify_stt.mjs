/**
 * gate 36 — v12 speech-to-text: when a recording ends, and what gets sent.
 *
 * Run:  node --experimental-strip-types scripts/verify_stt.mjs
 *       (or `npm run gate`. No browser, no microphone, no network, NO SARVAM KEY.)
 *
 * WHAT THIS PROTECTS. Everything expensive about voice input is a timing decision made
 * against a number nobody can see: how quiet counts as quiet, how long quiet has to last,
 * and whether the thing you captured is worth a request at all. Get one wrong and the
 * symptom is never "the timer is off" — it is "the microphone is broken", reported by
 * someone standing in front of a fridge.
 *
 * UNLIKE chat-ui's gate 32, THIS ONE RUNS THE REAL CODE. Node 22 strips the types off
 * `src/lib/stt.ts` and imports it directly, so there is no second copy of the policy to
 * drift from the first. That is possible only because `nextRecorderState`, `rmsOf` and
 * `shouldTranscribe` are pure — if a future change moves a threshold decision into the
 * `Recorder` class, this gate quietly stops covering it, and the fix is to move it back
 * out rather than to weaken the gate.
 *
 * What it does NOT cover: MediaRecorder, getUserMedia, AudioContext, and whether the
 * dev-server proxy actually reaches Sarvam. Those need the live browser run.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  MAX_UTTERANCE_MS,
  MIN_UTTERANCE_MS,
  SILENCE_HOLD_MS,
  SPEECH_RMS,
  STT_ENDPOINT,
  STT_LANGUAGE,
  STT_MODEL,
  SttUnavailable,
  TARGET_SAMPLE_RATE,
  encodeWav,
  explainStatus,
  initialProgress,
  mergeSamples,
  nextRecorderState,
  rmsOf,
  shouldTranscribe,
  transcribe,
} from "../src/lib/stt.ts";

const here = dirname(fileURLToPath(import.meta.url));
const failures = [];
const check = (ok, what) => {
  if (!ok) failures.push(what);
};

/** Drive the real state machine over a run of frames, 60ms apart. `levels` is per frame. */
function play(levels, stepMs = 60) {
  let progress = initialProgress();
  let elapsedMs = 0;
  for (const level of levels) {
    elapsedMs += stepMs;
    progress = nextRecorderState(progress, { elapsedMs, level });
    if (progress.phase === "stopping") return { progress, elapsedMs };
  }
  return { progress, elapsedMs };
}

const QUIET = 0.002;
const LOUD = 0.2;
const frames = (ms, level, stepMs = 60) => Array(Math.ceil(ms / stepMs)).fill(level);

// --- 1. silence BEFORE speech must never stop a recording ----------------------------
// The slow starter: tap the mic, think, then speak. Cut them off here and the bug looks
// like a dead microphone.
{
  const { progress } = play(frames(SILENCE_HOLD_MS * 3, QUIET));
  check(
    progress.phase !== "stopping",
    `silence before any speech must NOT stop the recording — got ${progress.phase}/${progress.reason}`,
  );
  check(progress.lastLoudMs === null, "no frame crossed SPEECH_RMS, so lastLoudMs must stay null");
}

// --- 2. silence AFTER speech must stop it, at SILENCE_HOLD_MS -------------------------
{
  const { progress, elapsedMs } = play([
    ...frames(600, LOUD),
    ...frames(SILENCE_HOLD_MS + 300, QUIET),
  ]);
  check(progress.phase === "stopping", "silence after speech must stop the recording");
  check(progress.reason === "silence", `stop reason must be "silence" — got ${progress.reason}`);
  const held = elapsedMs - progress.lastLoudMs;
  check(
    held >= SILENCE_HOLD_MS && held < SILENCE_HOLD_MS + 120,
    `it must stop ~SILENCE_HOLD_MS after the last loud frame, not sooner or much later — held ${held}ms`,
  );
}

// A frame exactly AT the threshold counts as speech. Stated because ">" instead of ">="
// here is a one-character change that shortens every recording by one frame.
{
  const progress = nextRecorderState(initialProgress(), { elapsedMs: 60, level: SPEECH_RMS });
  check(progress.phase === "speaking", "a frame exactly at SPEECH_RMS must count as speech");
}

// --- 3. a recording too short, or one nobody spoke into, is discarded -----------------
{
  const spoke = { phase: "speaking", lastLoudMs: 200, reason: null };
  const silent = { phase: "listening", lastLoudMs: null, reason: null };
  check(
    !shouldTranscribe(spoke, MIN_UTTERANCE_MS - 1),
    "a stray tap under MIN_UTTERANCE_MS must not be sent — Sarvam answers it with an empty transcript that reads as a bug",
  );
  check(shouldTranscribe(spoke, MIN_UTTERANCE_MS), "a recording at MIN_UTTERANCE_MS must be sent");
  check(
    !shouldTranscribe(silent, MAX_UTTERANCE_MS),
    "a recording in which no frame ever crossed SPEECH_RMS must not be sent, however long — that is a muted OS-level mic, and the honest answer is 'I didn't hear anything'",
  );
}

// --- 4. the ceiling stops it regardless of level --------------------------------------
{
  const { progress, elapsedMs } = play(frames(MAX_UTTERANCE_MS + 1000, LOUD));
  check(progress.phase === "stopping", "MAX_UTTERANCE_MS must stop a recording that never goes quiet");
  check(
    progress.reason === "max_duration",
    `stop reason must be "max_duration" — got ${progress.reason}`,
  );
  check(elapsedMs <= MAX_UTTERANCE_MS + 120, `the ceiling must be honoured promptly — ran ${elapsedMs}ms`);
}

// A recording nobody speaks into still ends: silence alone cannot stop it (assertion 1),
// so the ceiling is the ONLY thing between a stuck-open tap and a mic held all afternoon.
{
  const { progress } = play(frames(MAX_UTTERANCE_MS + 500, QUIET));
  check(
    progress.phase === "stopping" && progress.reason === "max_duration",
    "an entirely silent recording must still end at the ceiling — nothing else can end it",
  );
}

// --- 5. rmsOf, over the -1…1 samples the audio graph actually hands us -----------------
{
  const silence = new Float32Array(1024);
  check(rmsOf(silence) === 0, `an all-zero buffer is silence — got ${rmsOf(silence)}`);
  check(rmsOf(silence) < SPEECH_RMS, "and silence must sit below SPEECH_RMS, or every recording is 'speaking'");

  const square = Float32Array.from({ length: 1024 }, (_, i) => (i % 2 ? 1 : -1));
  check(Math.abs(rmsOf(square) - 1) < 1e-6, `a full-scale square must read 1.0 — got ${rmsOf(square)}`);

  const sine = Float32Array.from({ length: 1024 }, (_, i) => Math.sin((i / 1024) * 2 * Math.PI * 8));
  check(Math.abs(rmsOf(sine) - 0.707) < 0.01, `a full-scale sine must read ~0.707 — got ${rmsOf(sine)}`);
  check(rmsOf(new Float32Array(0)) === 0, "an empty frame must be 0, not NaN");
}

// --- 5b. the WAV we write, because Sarvam will not take anything else -----------------
// MEASURED 2026-08-08: MediaRecorder's WebM is REJECTED — `400 Invalid file type:
// audio/webm;codecs=opus` — despite Sarvam's docs listing WebM as supported. So the
// container is hand-written here, and that makes it ours to get right.
{
  check(mergeSamples([]).length === 0, "merging nothing must give an empty buffer, not throw");
  const merged = mergeSamples([Float32Array.from([0.1, 0.2]), Float32Array.from([0.3])]);
  check(merged.length === 3 && Math.abs(merged[2] - 0.3) < 1e-6, "buffers must concatenate in order");

  const samples = Float32Array.from([0, 0.5, -0.5, 1, -1, 2, -2]);
  const wav = encodeWav(samples, TARGET_SAMPLE_RATE);
  check(wav.type === "audio/wav", `the blob must be typed audio/wav — got ${wav.type}`);
  const bytes = new DataView(await wav.arrayBuffer());
  const tag = (at) => String.fromCharCode(...new Uint8Array(bytes.buffer, at, 4));

  check(tag(0) === "RIFF" && tag(8) === "WAVE" && tag(12) === "fmt " && tag(36) === "data", "the RIFF/WAVE/fmt/data tags must be where a WAV parser looks for them");
  check(bytes.byteLength === 44 + samples.length * 2, `header + 16-bit samples — got ${bytes.byteLength}`);
  check(bytes.getUint32(4, true) === 36 + samples.length * 2, "the RIFF size field must be real, not a streaming placeholder — fish.audio ships 0xffffffff there and ffmpeg refuses the file");
  check(bytes.getUint32(40, true) === samples.length * 2, "the data chunk must declare its own length");
  check(bytes.getUint16(20, true) === 1 && bytes.getUint16(22, true) === 1 && bytes.getUint16(34, true) === 16, "uncompressed PCM, mono, 16-bit");
  check(bytes.getUint32(24, true) === TARGET_SAMPLE_RATE, `the sample rate must be the one we opened the AudioContext at (${TARGET_SAMPLE_RATE})`);
  check(bytes.getUint32(28, true) === TARGET_SAMPLE_RATE * 2 && bytes.getUint16(32, true) === 2, "byte rate and block align must agree with mono 16-bit");

  check(bytes.getInt16(44, true) === 0, "silence stays silence");
  check(bytes.getInt16(44 + 3 * 2, true) === 32767, `a +1.0 sample must saturate to 32767 — 1.0 * 32768 wraps to -32768, turning a loud syllable into a click (got ${bytes.getInt16(44 + 6, true)})`);
  check(bytes.getInt16(44 + 4 * 2, true) === -32767, "and -1.0 to -32767");
  check(bytes.getInt16(44 + 5 * 2, true) === 32767 && bytes.getInt16(44 + 6 * 2, true) === -32767, "samples beyond ±1 must CLAMP, not wrap — an over-driven mic buzzes instead of transcribing");
}

// --- 6. what actually goes on the wire -------------------------------------------------
{
  const realFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ transcript: "  plan our meals  ", language_code: "en-IN" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await transcribe(encodeWav(Float32Array.from([0, 0.5]), TARGET_SAMPLE_RATE));

  check(seen?.url === STT_ENDPOINT, `it must post to the same-origin proxy ${STT_ENDPOINT} — got ${seen?.url}`);
  check(seen?.init?.method === "POST", "it must be a POST");
  check(
    seen?.init?.headers === undefined,
    "NO Content-Type may be set by hand — only the browser knows the multipart boundary it just generated, and setting it produces a body the server cannot split (a 400 that reads like bad audio)",
  );
  const form = seen?.init?.body;
  check(form instanceof FormData, "the body must be FormData");
  check(form?.get("model") === STT_MODEL, `model must be ${STT_MODEL} — got ${form?.get("model")}`);
  check(
    form?.get("language_code") === STT_LANGUAGE,
    `language_code must be "${STT_LANGUAGE}" (auto-detect, which is why we are on Sarvam at all) — got ${form?.get("language_code")}`,
  );
  check(
    form?.get("file")?.name === "utterance.wav",
    `the filename must be .wav — Sarvam validates the container and rejects webm outright (got ${form?.get("file")?.name})`,
  );
  check(form?.get("file")?.type === "audio/wav", `and the blob must be typed audio/wav — got ${form?.get("file")?.type}`);
  check(result.text === "plan our meals", `the transcript must be trimmed — got ${JSON.stringify(result.text)}`);
  check(result.language === "en-IN", "the detected language must be surfaced, not dropped");

  // --- 7. a failure must RAISE, never return an empty transcript ----------------------
  // 403, not 401: measured against a deliberately wrong key, Sarvam answers
  // `403 invalid_api_key_error`. Testing only the 401 would have missed the real case.
  globalThis.fetch = async () => new Response('{"error":{"code":"invalid_api_key_error"}}', { status: 403 });
  let raised = null;
  try {
    await transcribe(encodeWav(Float32Array.from([0, 0.5]), TARGET_SAMPLE_RATE));
  } catch (error) {
    raised = error;
  }
  check(
    raised instanceof SttUnavailable,
    "a non-200 must raise — returning an empty transcript would render as 'it heard nothing', which is a different problem with a different fix",
  );
  check(raised?.status === 403, "the status must survive onto the error, so the UI can say WHICH failure");
  check(/SARVAM_API_KEY/.test(raised?.message ?? ""), "a rejected key must be named as such, not reported as a number");
  check(/SARVAM_API_KEY/.test(explainStatus(401, "")), "401 must be handled too — Sarvam uses 403, but a proxy in front of it may not");
  check(/npm run dev/.test(explainStatus(404, "")), "a 404 must name the dev-server-only limitation — that is the failure a built bundle produces");

  globalThis.fetch = realFetch;
}

// --- 8. the key must be structurally unable to reach the bundle ------------------------
// Not a style check. `VITE_SARVAM_API_KEY` would work exactly as well at runtime and
// would ship the credential to every browser that loads the page.
{
  const config = readFileSync(join(here, "../vite.config.ts"), "utf8");
  check(
    /loadEnv\(\s*mode\s*,\s*process\.cwd\(\)\s*,\s*""\s*\)/.test(config),
    'vite.config.ts must call loadEnv with "" as the prefix — the default "VITE_" hands back an empty key and the mic silently never works',
  );
  check(
    !/VITE_SARVAM/.test(config),
    "SARVAM_API_KEY must NOT carry a VITE_ prefix — that prefix is the one thing standing between this credential and every browser that loads the page",
  );
  check(
    /__STT_READY__:\s*JSON\.stringify\(Boolean\(/.test(config),
    "the client may be told WHETHER a key exists (a boolean), never the key",
  );
  check(
    /setHeader\(\s*["']api-subscription-key["']/.test(config),
    "Sarvam authenticates on the api-subscription-key header, not a bearer Authorization",
  );

  // Comments stripped: both files EXPLAIN the proxy and the key at length, and prose
  // about a thing must not read as a use of it.
  const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const stt = code(readFileSync(join(here, "../src/lib/stt.ts"), "utf8"));
  check(
    !/SARVAM_API_KEY/.test(stt.replace(/Check SARVAM_API_KEY[^`"']*/g, "")),
    "src/ may name the key only inside an error message — never read it",
  );
  check(
    !/api\.sarvam\.ai/.test(stt),
    "the browser must post to the same-origin proxy, never to api.sarvam.ai directly (that is the CORS gamble the proxy exists to avoid)",
  );
  check(
    !/MediaRecorder/.test(stt),
    "MediaRecorder must NOT come back. It is the obvious way to record in a browser and it produces WebM, which Sarvam rejects with a 400 — measured, against documentation that says otherwise. Capture PCM and write the WAV.",
  );
}

// --- report ---------------------------------------------------------------------------
if (failures.length) {
  console.error(`\ngate 36 FAILED — ${failures.length} check(s):\n`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log("gate 36 (v12 speech-to-text) passed");
