# AGENTS.md — goal-flow-agent-bixby-ui (coding-session guide)

Context for an AI/coding session in this repo. Read first.

## What this repo is

The **dev surrogate for the native Tizen Bixby entry point** of GoalFlow — a two-tier
goal-based agent POC for the Samsung Tizen Family Hub. Introduced in **v4.1**.

On a device, Bixby is a **native app** (ASR + webview control). This repo is a browser
stand-in so the Bixby → cloud → chat-webview handoff is testable in dev without a device.
It is deliberately **tiny**: an input box that sends `user_goal` to the cloud (with a
microphone beside it since v12 — Sarvam STT standing in for Bixby's native ASR), and a
listener that opens/closes the chat UI on `chat_ui_open`/`chat_ui_close`.

It renders NONE of the planning/board content. The cloud **forks the `input` surface**
(v4.1), so this client receives only its lifecycle frames: `hello_ack`, `goal_accepted`,
`chat_ui_open`, `chat_ui_close`, `notice`.

Siblings under `~/ashu/git/`: `goal-flow-cloud-agent` (Python hub, owns canonical
`CONTRACT.md`), `goal-flow-agent-chat-ui` (the webview this opens),
`goal-flow-agent-board-ui` (the ambient board). The system design lives in
`../goal-flow-agents/docs/DESIGN.md` — the surface fork and the create-phase bracket are §6.

## Stack & run

- React + Vite + TypeScript (mirrors the chat/board UIs). Talks only to the cloud via
  `VITE_WS_URL` (default `ws://localhost:8000/ws`). Declares `surface: "input"` in `hello`.
- Dev: `npm run dev`. Build: `npm run build`. Gate: `npm run gate` (v12, offline).
- Ports: chat UI = 5173, board UI = 5174 — pick a distinct port here (e.g. 5175).

## v12 — speech input (Sarvam STT). Read this before touching `lib/stt.ts`.

The composer has a real microphone now: tap → record → ~1.5 s of silence stops it →
Sarvam transcribes → the text lands **in the box**, and the user still taps Send.

**It changes nothing on the wire.** Native Bixby does its own on-device ASR; this is the
surrogate finally doing in the browser what it faked with a textarea since v4.1. No
contract frame, no cloud change, no other repo. If a future change makes voice input send
a `user_goal` by itself, that is a product decision to take deliberately — the current
behaviour is the one that keeps a misheard word cheap.

Five things that will otherwise cost an afternoon:

0. **SARVAM REJECTS WebM, WHATEVER ITS DOCS SAY.** `MediaRecorder` is the obvious way to
   record in a browser and it produces WebM/Opus; the Sarvam docs list WebM as a
   supported container. Measured 2026-08-08 against a real recording:
   `400 Invalid file type: audio/webm;codecs=opus. Only ['audio/mpeg', 'audio/mp3', …,
   'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/pcm_s1…`. So there is no
   `MediaRecorder` here at all: PCM comes off the audio graph and `encodeWav` writes the
   container by hand. Gate 36 fails if `MediaRecorder` reappears. Related measured fact:
   a bad key is **403 `invalid_api_key_error`**, not the 401 you would test for.


1. **`SARVAM_API_KEY` has no `VITE_` prefix, and that is load-bearing.** Vite exposes
   `VITE_`-prefixed vars to client code and refuses the rest, so the prefix is the only
   thing between this credential and every browser that loads the page. It is read in
   Node by `vite.config.ts`, which proxies same-origin `/api/stt` → `api.sarvam.ai` with
   the key attached — which also means no CORS gamble. The page is told a BOOLEAN
   (`__STT_READY__`), never the key. Gate 36 fails if this is reversed.
2. **The proxy is the dev server's, so this is `npm run dev` only.** `vite preview` and any
   built bundle 404 on `/api/stt`. Acceptable for a dev surrogate; the fix, if it is ever
   needed, is to move the call to the cloud hub beside `speech/client.py`.
3. **`getUserMedia` needs a secure context.** `localhost:5175` qualifies; the LAN address
   `host: true` also serves does not, and there the mic is *missing*, not broken.
4. **Keep the timing decisions PURE.** `rmsOf`, `nextRecorderState` and `shouldTranscribe`
   are plain functions, which is the only reason `scripts/verify_stt.mjs` can import and
   run the real code (Node 22 type-stripping) instead of keeping a second copy that
   drifts. Move a threshold into the `Recorder` class and the gate silently stops
   covering it.

The two rules the thresholds encode, both learned from how this fails in front of people:
silence can only end a recording **after speech has been heard** (otherwise a slow starter
is cut off before their first word and blames the microphone), and a recording nobody
actually spoke into is **not sent** (a muted OS-level mic deserves "I didn't hear
anything", not an empty box).

## Contract touchpoints

- Sends: `hello {role:"ui", surface:"input"}`, `user_goal {text, client_ref}`.
- Receives (forked): `hello_ack`, `goal_accepted`, `chat_ui_open {goal_id}`,
  `chat_ui_close {goal_id}`, `notice`. Everything else is NOT delivered to this surface.
- On `chat_ui_open` → open the chat UI (iframe/tab at the chat-ui origin, `?device=<id>`).
  On `chat_ui_close` → close it. On `notice` (out-of-scope) → show/speak it, no webview.
- **v11: the webview iframe carries `allow="autoplay"`, and it is load-bearing.** The
  chat UI is served from a different port, so it is CROSS-ORIGIN to this page and
  Permissions Policy disables autoplay in it outright — `audio.play()` rejects before
  user activation is even consulted. Without the attribute the cloud's `speech` frame
  arrives, the chat UI is refused, and it falls back to a "Hear this" tap: working, but
  it hides a permission problem behind a button. This surrogate is the BEST case, not
  the contract — a real Hub's native Bixby creates the WebView and we can set nothing on
  it, which is why the chat UI degrades on its own (`chat-ui/src/lib/speech.ts`).
- This surface does **not** receive `speech` — the input fork does not deliver it, on
  purpose. The voice belongs to the surface showing the card it describes.

## Status

Built and in use, through **v12** (speech input, above). The v4.1 shape — `surface` plus
the `chat_ui_open` / `chat_ui_close` bracket — is what the cloud's `CONTRACT.md` describes,
and nothing since has changed it from this side.
