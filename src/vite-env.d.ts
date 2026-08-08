/// <reference types="vite/client" />

/**
 * The surrogate's two knobs. Both OPTIONAL: with neither set, the app derives the
 * cloud hub from its own hostname and the chat webview from localhost:5173, so a
 * device on the LAN works with no config. Typing them here makes a typo in a VITE_
 * name a build error rather than a silent `undefined` at runtime.
 */
interface ImportMetaEnv {
  /** ws://host:8000/ws — the cloud hub. */
  readonly VITE_WS_URL?: string;
  /** http://host:5173 — the chat UI the webview surrogate iframe points at. */
  readonly VITE_CHAT_UI_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * v12 — is a Sarvam key configured? A BOOLEAN, substituted at serve time by the `define`
 * in vite.config.ts, and deliberately not the key itself: `SARVAM_API_KEY` carries no
 * `VITE_` prefix precisely so it can never reach this bundle. The mic button reads this
 * to explain why it is disabled BEFORE anyone presses it and waits for a 401.
 */
declare const __STT_READY__: boolean;
