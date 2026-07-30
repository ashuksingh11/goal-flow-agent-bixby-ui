# AGENTS.md — goal-flow-agent-bixby-ui (coding-session guide)

Context for an AI/coding session in this repo. Read first.

## What this repo is

The **dev surrogate for the native Tizen Bixby entry point** of GoalFlow — a two-tier
goal-based agent POC for the Samsung Tizen Family Hub. Introduced in **v4.1**.

On a device, Bixby is a **native app** (ASR + webview control). This repo is a browser
stand-in so the Bixby → cloud → chat-webview handoff is testable in dev without a device.
It is deliberately **tiny**: an input box (replacing ASR) that sends `user_goal` to the
cloud, and a listener that opens/closes the chat UI on `chat_ui_open`/`chat_ui_close`.

It renders NONE of the planning/board content. The cloud **forks the `input` surface**
(v4.1), so this client receives only its lifecycle frames: `hello_ack`, `goal_accepted`,
`chat_ui_open`, `chat_ui_close`, `notice`.

Siblings under `~/ashu/git/`: `goal-flow-cloud-agent` (Python hub, owns canonical
`CONTRACT.md`), `goal-flow-agent-chat-ui` (the webview this opens),
`goal-flow-agent-board-ui` (the ambient board). The system design lives in
`goal-flow-agents/docs/DESIGN.md` — the surface fork and the create-phase bracket are §6.

## Stack & run

- React + Vite + TypeScript (mirrors the chat/board UIs). Talks only to the cloud via
  `VITE_WS_URL` (default `ws://localhost:8000/ws`). Declares `surface: "input"` in `hello`.
- Dev: `npm run dev`. Build: `npm run build`.
- Ports: chat UI = 5173, board UI = 5174 — pick a distinct port here (e.g. 5175).

## Contract touchpoints

- Sends: `hello {role:"ui", surface:"input"}`, `user_goal {text, client_ref}`.
- Receives (forked): `hello_ack`, `goal_accepted`, `chat_ui_open {goal_id}`,
  `chat_ui_close {goal_id}`, `notice`. Everything else is NOT delivered to this surface.
- On `chat_ui_open` → open the chat UI (iframe/tab at the chat-ui origin, `?device=<id>`).
  On `chat_ui_close` → close it. On `notice` (out-of-scope) → show/speak it, no webview.

## Status

v4.1 scaffold — implementation follows the v4.1 architecture doc (Fable) and the
cloud `CONTRACT.md` `surface` + lifecycle-frame additions. Not built yet.
