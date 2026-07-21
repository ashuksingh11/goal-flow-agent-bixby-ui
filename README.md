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

## Status

v4.1 scaffold. Implementation follows the v4.1 architecture doc (contract `surface`
field + `chat_ui_open` / `chat_ui_close` frames). See the cloud-agent `CONTRACT.md` and
`goal-flow-agents/docs/V4_PLAN.md`.
