# goal-flow-agent-bixby-ui

**Dev surrogate for the native Tizen Bixby entry point** in the GoalFlow two-tier
goal-agent POC. Introduced in **v4.1**.

## What it stands in for

On a real Family Hub, **Bixby is a native app**, not a web page. The production flow is:

1. User taps the Bixby icon → native input box opens → user speaks → on-device **ASR** → text.
2. Bixby sends that text to the **cloud agent** as a `user_goal` (declaring `surface: "input"`).
3. When the cloud replies with **`chat_ui_open`**, Bixby opens a **webview** hosting the
   chat UI, and the create/planning phase renders there (and mirrors on the Agent Board).
4. When the cloud sends **`chat_ui_close`** (initial plan approved), Bixby closes the
   webview; execution continues on the Agent Board.
5. A new utterance repeats the cycle.

This repo is a **browser stand-in** for steps 1–4 so the whole handoff is testable in dev
**without a Tizen device**. It does exactly — and *only* — what native Bixby does:

- sends `user_goal` to the cloud with `surface: "input"` (text box replaces ASR in dev);
- listens for `chat_ui_open` / `chat_ui_close` and opens / closes the chat UI accordingly
  (e.g. an iframe or a popped tab pointing at `goal-flow-agent-chat-ui`).

It renders **none** of the planning/board content itself — the cloud forks the `input`
surface so this client only receives its lifecycle frames (`hello_ack`, `goal_accepted`,
`chat_ui_open`, `chat_ui_close`, `notice`).

## Not this repo's job

- No plan / understanding / approval rendering — that is `goal-flow-agent-chat-ui`.
- No live board — that is `goal-flow-agent-board-ui`.
- No Tizen packaging — the user ports this behaviour into the native Bixby app by hand.

## Run

A deliberately tiny Vite + React + TS app (mirrors the chat/board UIs).

```bash
npm install
npm run dev        # serves on http://localhost:5175
```

It needs two siblings running:

- the **cloud hub** on `:8000` (`goal-flow-cloud-agent`) — the WebSocket it connects to;
- the **chat UI** on `:5173` (`goal-flow-agent-chat-ui`) — what the webview surrogate
  iframe loads when a `chat_ui_open` arrives.

A device agent must also be online so the UI can bind (one device auto-binds; several
show the picker).

**Config** (all optional — see `.env.example`):

- `VITE_WS_URL` — the cloud hub. Default `ws://<page-host>:8000/ws`.
- `VITE_CHAT_UI_URL` — the chat UI origin the iframe points at. Default
  `http://localhost:5173`. The bound `device_id` is appended as `?device=<id>`.
- `SARVAM_API_KEY` — **v12**, enables the microphone. Note the *missing* `VITE_` prefix;
  see below and `.env.example`.

Ports across the surfaces: chat = 5173, board = 5174, **bixby = 5175**.

Before committing: `npm run build` (`tsc -b && vite build`) and `npm run gate`
(`scripts/verify_stt.mjs` — offline, no key, no browser).

## v12 — the surrogate listens (Sarvam speech-to-text)

The composer has a **microphone**: tap it, speak, and ~1.5 s of silence ends the recording
(a second tap ends it early; 15 s is a hard ceiling). The audio goes to Sarvam's
`speech-to-text`, language auto-detected, and the transcript lands **in the text box** —
you read it and tap **Send**. It never sends itself: a misheard word should cost a
keystroke, not a full planning cycle.

**This is surrogate fidelity, not a contract change.** Native Bixby does its own on-device
ASR, which is Samsung's and not ours; nothing here reaches the wire. The cloud still
receives exactly the `user_goal { text, client_ref }` it always did, and no other repo
moves.

Four facts worth knowing before you debug it:

- **The audio is a hand-written 16 kHz WAV, not `MediaRecorder` output.** Sarvam rejects
  WebM with a `400 Invalid file type` despite its docs listing WebM as supported
  (measured), so PCM is captured off the audio graph and the container written directly.
  Don't reintroduce `MediaRecorder` — `npm run gate` fails if you do.

- **The key is never in the bundle.** `SARVAM_API_KEY` carries no `VITE_` prefix — that is
  the mechanism, not a convention. `vite.config.ts` reads it in Node and proxies
  same-origin `/api/stt` to Sarvam with the key attached, which also sidesteps CORS
  entirely. The page gets a boolean (`__STT_READY__`), so a disabled mic can explain
  itself before you press it.
- **`npm run dev` only.** The proxy is the dev server's; under `vite preview` or a built
  bundle `/api/stt` is a 404, and the error message says so.
- **`localhost`, not the LAN address.** `getUserMedia` needs a secure context. `host: true`
  also serves this app on a LAN IP, where the mic is *absent* rather than broken.

## What you'll see

1. A text box + **mic** + **Send** that sends `user_goal { text, client_ref }`.
2. A **device picker** if more than one device is online (binds the socket — an unbound
   UI can't send).
3. A **"Bixby speaks:" banner** for inbound `notice` (out-of-scope or declined goals).
4. A **webview surrogate** — an `<iframe>` at the chat UI — that MOUNTS on `chat_ui_open`
   and UNMOUNTS on the matching `chat_ui_close`. Mount/unmount (not hide/show) so the
   surrogate exercises the webview reload path a real Bixby's reset also has to survive.

## Status

Built, through **v12** (speech input). The contract's `surface` field plus the
`chat_ui_open` / `chat_ui_close` bracket are what make this surface work — see the cloud
agent's `CONTRACT.md` and `goal-flow-agents/docs/DESIGN.md` §6.
