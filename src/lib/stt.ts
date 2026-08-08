/**
 * v12 — speech to text, via Sarvam. The half of the voice loop v11 did not build.
 *
 * On a real Family Hub this file does not exist: Bixby is a NATIVE app and its ASR is
 * Samsung's, running on the device, before anything leaves it. This is the dev surrogate
 * finally doing in the browser what it has been faking with a textarea since v4.1 — so
 * it is a fidelity improvement, NOT a contract change. Nothing downstream moves: the
 * transcript lands in the same box, and the same `user_goal {text, client_ref}` goes out.
 *
 * The network call goes to same-origin `/api/stt`, which the VITE DEV SERVER proxies to
 * `https://api.sarvam.ai/speech-to-text` with the key attached. See vite.config.ts for
 * why (the key never enters the bundle; no CORS gamble) and for the cost (dev server
 * only).
 *
 * WHY THERE IS NO MediaRecorder HERE. The obvious way to record in a browser is
 * `MediaRecorder`, which produces WebM/Opus — and Sarvam's own documentation lists WebM
 * as a supported container. IT IS NOT. Measured 2026-08-08 against a real recording:
 *
 *     400 Invalid file type: audio/webm;codecs=opus. Only ['audio/mpeg', 'audio/mp3',
 *     'audio/mpeg3', 'audio/x-mpeg-3', 'audio/x-mp3', 'audio/wav', 'audio/x-wav',
 *     'audio/wave', 'audio/pcm_s1…
 *
 * So we capture raw PCM off the audio graph and write our own WAV. That turns out to be
 * the better shape anyway: the AudioContext is opened AT 16 kHz — the rate Sarvam says
 * it works best at — so the browser resamples for us, one node does both the capture and
 * the level meter, and there is no container negotiation to get wrong.
 *
 * THE SPLIT THAT MATTERS: everything that decides *when a recording ends* and *what goes
 * on the wire* is pure — `rmsOf`, `nextRecorderState`, `shouldTranscribe`, `encodeWav`.
 * `Recorder` only wires those to the DOM. That is what lets `scripts/verify_stt.mjs` run
 * the REAL functions with no browser and no key, rather than a hand-copy that can drift.
 */

// ---------------------------------------------------------------------------
// The thresholds. One place, named, because every one of them is a judgement call
// someone will want to re-tune with a microphone in front of them.
// ---------------------------------------------------------------------------

/** RMS (0…1) at or above which a frame counts as speech rather than room noise. */
export const SPEECH_RMS = 0.02;
/** Silence this long AFTER speech has been heard ends the recording. */
export const SILENCE_HOLD_MS = 1500;
/** Shorter than this and we do not spend a request on it — see `shouldTranscribe`. */
export const MIN_UTTERANCE_MS = 700;
/** A hard ceiling, so a stuck-open mic cannot upload a minute of a kitchen. */
export const MAX_UTTERANCE_MS = 15000;
/** Sarvam's documented sweet spot. The AudioContext is opened here, so it resamples. */
export const TARGET_SAMPLE_RATE = 16000;
/** Capture granularity: 2048 frames at 16 kHz = 128 ms per level sample. */
export const CAPTURE_BUFFER_SIZE = 2048;

// ---------------------------------------------------------------------------
// Pure: the recording state machine
// ---------------------------------------------------------------------------

export type RecorderPhase = "idle" | "listening" | "speaking" | "stopping";
export type StopReason = "silence" | "max_duration" | "manual";

export interface RecorderProgress {
  phase: RecorderPhase;
  /** `elapsedMs` of the most recent frame at or above SPEECH_RMS; null until one. */
  lastLoudMs: number | null;
  /** Set once, when `phase` becomes "stopping". */
  reason: StopReason | null;
}

export interface RecorderTick {
  /** Milliseconds since the recording started. */
  elapsedMs: number;
  /** RMS of the current audio frame, 0…1. */
  level: number;
}

export function initialProgress(): RecorderProgress {
  return { phase: "listening", lastLoudMs: null, reason: null };
}

/**
 * Advance the recording by one captured buffer. Pure — same input, same output, no clock
 * of its own.
 *
 * THE RULE THAT IS EASY TO GET WRONG: silence can only end a recording once speech has
 * actually been heard. Without that guard, someone who taps the mic and then thinks for
 * two seconds is cut off before their first word, and the failure looks like a broken
 * microphone rather than an impatient timer. `MAX_UTTERANCE_MS` is the only thing that
 * stops a recording nobody ever spoke into.
 */
export function nextRecorderState(prev: RecorderProgress, tick: RecorderTick): RecorderProgress {
  if (prev.phase === "stopping" || prev.phase === "idle") return prev;

  const loud = tick.level >= SPEECH_RMS;
  const lastLoudMs = loud ? tick.elapsedMs : prev.lastLoudMs;
  const phase: RecorderPhase = prev.phase === "speaking" || loud ? "speaking" : "listening";

  if (tick.elapsedMs >= MAX_UTTERANCE_MS) {
    return { phase: "stopping", lastLoudMs, reason: "max_duration" };
  }
  if (lastLoudMs !== null && tick.elapsedMs - lastLoudMs >= SILENCE_HOLD_MS) {
    return { phase: "stopping", lastLoudMs, reason: "silence" };
  }
  return { phase, lastLoudMs, reason: null };
}

/**
 * Is this recording worth a request? Pure.
 *
 * Two things get thrown away here rather than sent. A stray tap (under
 * `MIN_UTTERANCE_MS`) — cheap to make, and Sarvam would answer with an empty transcript
 * that reads exactly like a bug. And a recording in which no frame ever crossed
 * `SPEECH_RMS`, which is what a muted OS-level microphone produces: the honest report is
 * "I did not hear anything", not a silent empty box.
 */
export function shouldTranscribe(progress: RecorderProgress, elapsedMs: number): boolean {
  return progress.lastLoudMs !== null && elapsedMs >= MIN_UTTERANCE_MS;
}

/** RMS of one buffer of -1…1 samples, i.e. 0…1. Pure. */
export function rmsOf(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

// ---------------------------------------------------------------------------
// Pure: PCM → WAV
// ---------------------------------------------------------------------------

/** Flatten the captured buffers into one run of samples. Pure. */
export function mergeSamples(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const merged = new Float32Array(total);
  let at = 0;
  for (const chunk of chunks) {
    merged.set(chunk, at);
    at += chunk.length;
  }
  return merged;
}

/**
 * Write mono 16-bit PCM into a WAV container. Pure — no DOM beyond `Blob`.
 *
 * The one thing to be careful about is the conversion at the top of the range: a sample
 * of exactly 1.0 times 32768 is 32768, which does not fit in a signed 16-bit integer and
 * wraps to -32768 — a full-scale positive peak becomes a full-scale NEGATIVE one. On a
 * loud syllable that is an audible click, and on a clipped recording it is a buzz that
 * Sarvam transcribes as nothing at all. Hence the clamp.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM header length
  view.setUint16(20, 1, true); // format 1 = uncompressed PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }
  return new Blob([bytes], { type: "audio/wav" });
}

// ---------------------------------------------------------------------------
// The Sarvam call
// ---------------------------------------------------------------------------

/** Same-origin. The dev server proxies it — see vite.config.ts. */
export const STT_ENDPOINT = "/api/stt";
/** Sarvam's current speech model. `saaras:v3` is the older one; `mode=codemix` is v3-only. */
export const STT_MODEL = "saaras:v4";
/**
 * Auto-detect. Sarvam returns the language it decided on, so a Hindi or code-mixed
 * utterance transcribes without a setting change — which is most of the reason to be on
 * Sarvam rather than the browser's own Web Speech API.
 */
export const STT_LANGUAGE = "unknown";

/** Transcription could not be done. Carries the status so the UI can say WHICH failure. */
export class SttUnavailable extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "SttUnavailable";
    this.status = status;
  }
}

export interface Transcript {
  text: string;
  /** e.g. "en-IN" — what Sarvam decided it heard, or null. */
  language: string | null;
}

/** Turn an HTTP failure into a sentence someone can act on without opening devtools. */
export function explainStatus(status: number, detail: string): string {
  const tail = detail ? ` — ${detail.slice(0, 200)}` : "";
  if (status === 401 || status === 403) {
    // Measured: a bad key is a 403 with `invalid_api_key_error`, not the 401 you expect.
    return `Sarvam rejected the key. Check SARVAM_API_KEY in .env and restart the dev server${tail}`;
  }
  if (status === 404) {
    return `The /api/stt proxy isn't there. This works under \`npm run dev\` only, not a built bundle${tail}`;
  }
  if (status === 413) return `That recording was too large for Sarvam${tail}`;
  if (status === 429) return `Sarvam is rate-limiting this key — try again in a moment${tail}`;
  if (status === 400 || status === 415 || status === 422) {
    return `Sarvam could not read that audio${tail}`;
  }
  return `Sarvam answered HTTP ${status}${tail}`;
}

/**
 * Send one recording to Sarvam and return what it heard.
 *
 * NO `Content-Type` HEADER IS SET HERE, deliberately. Only the browser knows the
 * multipart boundary it just generated for this FormData; setting the header by hand
 * produces a body the server cannot split, and the resulting 400 reads like bad audio
 * rather than like the header mistake it is.
 */
export async function transcribe(wav: Blob): Promise<Transcript> {
  const form = new FormData();
  // The filename matters: Sarvam validates the container, and `.wav` is one of the few
  // it accepts (WebM is not — see the header of this file).
  form.append("file", wav, "utterance.wav");
  form.append("model", STT_MODEL);
  form.append("language_code", STT_LANGUAGE);

  let response: Response;
  try {
    response = await fetch(STT_ENDPOINT, { method: "POST", body: form });
  } catch (error) {
    throw new SttUnavailable(`Could not reach the transcription proxy: ${String(error)}`);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new SttUnavailable(explainStatus(response.status, detail), response.status);
  }

  const payload = (await response.json()) as { transcript?: string; language_code?: string | null };
  return {
    text: (payload?.transcript ?? "").trim(),
    language: payload?.language_code ?? null,
  };
}

// ---------------------------------------------------------------------------
// The DOM half
// ---------------------------------------------------------------------------

/** Is voice input possible in this page at all? */
export function micSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof AudioContext !== "undefined"
  );
}

/** Why the microphone refused. `getUserMedia`'s own messages are not user-facing. */
export function explainMicError(error: unknown): string {
  const name = (error as { name?: string } | null)?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    // The second half of this is the trap: `host: true` also serves a LAN address, and
    // getUserMedia is unavailable there because it is not a secure context. The symptom
    // is a permission error on a page nobody was ever asked about.
    return "Microphone permission was refused. If this page is on a LAN address rather than localhost, the browser blocks the mic outright.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No microphone was found.";
  }
  if (name === "NotReadableError") {
    return "The microphone is busy in another app.";
  }
  return `The microphone could not be opened: ${String(error)}`;
}

export interface RecordingResult {
  wav: Blob;
  sampleRate: number;
  durationMs: number;
  reason: StopReason;
}

export interface RecorderCallbacks {
  /** Every captured buffer (~128 ms), 0…1. Drives the meter. */
  onLevel?: (level: number) => void;
  onPhase?: (phase: RecorderPhase) => void;
}

/**
 * One recording, start to finish.
 *
 * `start()` resolves when the recording ENDS — by silence, by the ceiling, or by a
 * `stop()` — with `null` when there was nothing worth sending. So the caller is one
 * `await`, not a callback tangle.
 */
export class Recorder {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private chunks: Float32Array[] = [];
  private callbacks: RecorderCallbacks = {};
  private progress: RecorderProgress = { phase: "idle", lastLoudMs: null, reason: null };
  private startedAt = 0;
  private active = false;
  private cancelled = false;
  private settle: ((result: RecordingResult | null) => void) | null = null;

  get recording(): boolean {
    return this.active;
  }

  async start(callbacks: RecorderCallbacks = {}): Promise<RecordingResult | null> {
    if (this.active) throw new SttUnavailable("Already recording.");

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (error) {
      throw new SttUnavailable(explainMicError(error));
    }

    this.stream = stream;
    this.callbacks = callbacks;
    this.chunks = [];
    this.cancelled = false;
    this.active = true;
    this.progress = initialProgress();
    this.startedAt = performance.now();

    const done = new Promise<RecordingResult | null>((resolve) => {
      this.settle = resolve;
    });

    // Opened AT the target rate, so the browser's own resampler does the 48k→16k step.
    // Doing it by hand would mean writing a low-pass filter to avoid aliasing, and a
    // naive every-third-sample decimation is exactly how speech turns to mush.
    const context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
    this.context = context;

    // ScriptProcessorNode is deprecated in favour of AudioWorklet, and used anyway:
    // a worklet needs its processor loaded from a separate URL, which for a page with
    // no build step of its own means a Blob URL and a second failure mode. This is a
    // dev surrogate; the node still ships in every engine we care about, and if it is
    // ever removed the replacement is contained entirely within this method.
    const processor = context.createScriptProcessor(CAPTURE_BUFFER_SIZE, 1, 1);
    this.processor = processor;
    processor.onaudioprocess = (event) => this.onBuffer(event.inputBuffer.getChannelData(0));

    // A ScriptProcessorNode only fires while it is connected to a destination — but
    // routing the microphone to the speakers is a feedback loop in front of an audience,
    // so it goes through a muted gain.
    const mute = context.createGain();
    mute.gain.value = 0;
    context.createMediaStreamSource(stream).connect(processor);
    processor.connect(mute);
    mute.connect(context.destination);

    callbacks.onPhase?.("listening");
    return done;
  }

  /** End the recording now and keep what was captured. */
  stop(): void {
    if (!this.active || this.progress.phase === "stopping") return;
    this.progress = { ...this.progress, phase: "stopping", reason: "manual" };
    this.callbacks.onPhase?.("stopping");
    this.finish();
  }

  /** End the recording and throw it away — `start()` resolves with null. */
  cancel(): void {
    if (!this.active) return;
    this.cancelled = true;
    this.finish();
  }

  private onBuffer(buffer: Float32Array): void {
    if (!this.active || this.progress.phase === "stopping") return;
    // COPIED, not referenced: the same underlying buffer is handed back to us next tick,
    // so keeping the reference would leave every chunk holding the final 128 ms.
    this.chunks.push(new Float32Array(buffer));

    const level = rmsOf(buffer);
    const before = this.progress;
    this.progress = nextRecorderState(before, {
      elapsedMs: performance.now() - this.startedAt,
      level,
    });
    this.callbacks.onLevel?.(level);
    if (this.progress.phase !== before.phase) this.callbacks.onPhase?.(this.progress.phase);
    if (this.progress.phase === "stopping") this.finish();
  }

  /** The only place a recording is settled. */
  private finish(): void {
    if (!this.active) return;
    this.active = false;

    const durationMs = performance.now() - this.startedAt;
    const sampleRate = this.context?.sampleRate ?? TARGET_SAMPLE_RATE;
    const samples = mergeSamples(this.chunks);
    const progress = this.progress;
    const cancelled = this.cancelled;
    const settle = this.settle;

    this.settle = null;
    this.teardown();

    if (!settle) return;
    if (cancelled || samples.length === 0 || !shouldTranscribe(progress, durationMs)) {
      settle(null);
      return;
    }
    settle({
      wav: encodeWav(samples, sampleRate),
      sampleRate,
      durationMs,
      reason: progress.reason ?? "manual",
    });
  }

  private teardown(): void {
    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
      this.processor = null;
    }
    // ALWAYS release the track, on every path including the failures. A live
    // MediaStreamTrack keeps the OS microphone indicator lit and the tab flagged as
    // recording — invisible in review, extremely visible on stage.
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    void this.context?.close().catch(() => {});
    this.context = null;
    this.chunks = [];
    this.callbacks = {};
    this.cancelled = false;
    this.active = false;
    this.progress = { phase: "idle", lastLoudMs: null, reason: null };
  }
}
