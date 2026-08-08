import { useCallback, useEffect, useRef, useState } from "react";
import {
  Recorder,
  SttUnavailable,
  micSupported,
  transcribe,
  type RecorderPhase,
} from "../lib/stt";

/**
 * v12 — the ASR stand-in, finally standing in for something.
 *
 * Tap to start; ~1.5s of silence after you speak ends it, and a second tap ends it early.
 * The transcript goes UP to App, which drops it in the composer — this component never
 * sends a goal. That is the decision the milestone was built around: the user reads what
 * was heard and taps Send, so a misheard word costs a keystroke rather than a full
 * planning cycle.
 *
 * On a real Hub none of this exists — native Bixby's own ASR does it. See lib/stt.ts.
 */

export interface MicButtonProps {
  /** The recognized utterance, once Sarvam answers. Never called with an empty string. */
  onTranscript: (text: string, language: string | null) => void;
  /** A failure the user can act on — the caller renders it near the composer. */
  onError: (message: string) => void;
  /** Cleared when a recording starts, so a stale error never outlives the next attempt. */
  onStart?: () => void;
  /** Disabled for the same reason Send is: an unbound socket can't deliver a goal. */
  disabled?: boolean;
}

type MicState = "idle" | "recording" | "transcribing";

/** Why the mic cannot be used at all, or "" when it can. */
function unavailableReason(): string {
  if (!micSupported()) {
    // Almost always the secure-context rule: `host: true` serves a LAN address too, and
    // getUserMedia simply does not exist there. It reads as "unsupported browser".
    return "This browser exposes no microphone here — load the surrogate on localhost, not the LAN address.";
  }
  if (!__STT_READY__) {
    return "No SARVAM_API_KEY in .env — set one and restart the dev server to enable speech input.";
  }
  return "";
}

export function MicButton({ onTranscript, onError, onStart, disabled = false }: MicButtonProps) {
  const [state, setState] = useState<MicState>("idle");
  const [phase, setPhase] = useState<RecorderPhase>("idle");
  const [level, setLevel] = useState(0);
  const recorderRef = useRef<Recorder | null>(null);
  const [blocked] = useState(unavailableReason);

  // A recording still running when this unmounts would hold the microphone open for the
  // life of the tab. Cancel discards it — a half-utterance is not worth a request.
  useEffect(() => () => recorderRef.current?.cancel(), []);

  const run = useCallback(async () => {
    onStart?.();
    const recorder = new Recorder();
    recorderRef.current = recorder;
    setState("recording");
    setPhase("listening");
    setLevel(0);

    let result;
    try {
      result = await recorder.start({ onLevel: setLevel, onPhase: setPhase });
    } catch (error) {
      recorderRef.current = null;
      setState("idle");
      setPhase("idle");
      onError(error instanceof SttUnavailable ? error.message : String(error));
      return;
    }

    recorderRef.current = null;
    setLevel(0);
    setPhase("idle");
    if (!result) {
      // Cancelled, or too short / never loud enough to be worth a request. Saying so is
      // the point — an empty composer with no explanation reads as a broken button.
      setState("idle");
      onError("I didn't hear anything — tap the mic and speak.");
      return;
    }

    setState("transcribing");
    try {
      const { text, language } = await transcribe(result.wav);
      if (!text) {
        onError("Sarvam returned nothing for that recording — try again.");
      } else {
        onTranscript(text, language);
      }
    } catch (error) {
      onError(error instanceof SttUnavailable ? error.message : String(error));
    } finally {
      setState("idle");
    }
  }, [onError, onStart, onTranscript]);

  const onClick = useCallback(() => {
    if (state === "recording") {
      recorderRef.current?.stop();
      return;
    }
    if (state === "idle") void run();
  }, [run, state]);

  const busy = state === "transcribing";
  const recording = state === "recording";
  const isDisabled = disabled || busy || Boolean(blocked);

  const label = recording ? "Stop recording" : busy ? "Transcribing…" : "Speak your goal";
  const title = blocked || (disabled ? "Bind a device first" : label);

  return (
    <div className="mic">
      <button
        type="button"
        className={`mic-btn${recording ? " recording" : ""}${busy ? " busy" : ""}`}
        onClick={onClick}
        disabled={isDisabled}
        aria-label={label}
        aria-pressed={recording}
        title={title}
      >
        <span className="mic-glyph" aria-hidden="true">
          {recording ? "■" : "●"}
        </span>
        {recording ? "Stop" : busy ? "…" : "Speak"}
      </button>

      {recording && (
        <span className="mic-level" aria-hidden="true">
          {/* Width follows the live RMS. Scaled 4x because ordinary speech sits around
              0.05-0.2 and a meter pinned to the bottom 20% reads as a dead microphone. */}
          <span className="mic-level-fill" style={{ width: `${Math.min(100, level * 400)}%` }} />
        </span>
      )}

      <span className="mic-status" aria-live="polite">
        {recording
          ? phase === "speaking"
            ? "listening…"
            : "waiting for you"
          : busy
            ? "transcribing…"
            : ""}
      </span>
    </div>
  );
}
