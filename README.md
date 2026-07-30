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

**Config** (both optional — see `.env.example`):

- `VITE_WS_URL` — the cloud hub. Default `ws://<page-host>:8000/ws`.
- `VITE_CHAT_UI_URL` — the chat UI origin the iframe points at. Default
  `http://localhost:5173`. The bound `device_id` is appended as `?device=<id>`.

Ports across the surfaces: chat = 5173, board = 5174, **bixby = 5175**.

Build (must pass clean before committing): `npm run build` (runs `tsc -b && vite build`).

## What you'll see

1. A text box + **Send** (the ASR stand-in) that sends `user_goal { text, client_ref }`.
2. A **device picker** if more than one device is online (binds the socket — an unbound
   UI can't send).
3. A **"Bixby speaks:" banner** for inbound `notice` (out-of-scope or declined goals).
4. A **webview surrogate** — an `<iframe>` at the chat UI — that MOUNTS on `chat_ui_open`
   and UNMOUNTS on the matching `chat_ui_close`. Mount/unmount (not hide/show) so the
   surrogate exercises the webview reload path a real Bixby's reset also has to survive.

## Status

Built. The contract's `surface` field plus the `chat_ui_open` / `chat_ui_close` bracket are
what make this surface work — see the cloud agent's `CONTRACT.md` and
`goal-flow-agents/docs/DESIGN.md` §6.
