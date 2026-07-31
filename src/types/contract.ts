/**
 * CANONICAL SPEC: CONTRACT v4.1, in the cloud repo (`goal-flow-cloud-agent/CONTRACT.md`).
 *
 * This file mirrors ONLY the frames this surface uses. The bixby surrogate stands in
 * for the native Tizen Bixby entry point, which declares `surface: "input"` in its
 * `hello`. The cloud FORKS the input surface (v4.1 "Surface-aware delivery"), so this
 * client receives just five inbound frames — everything else in the session broadcast
 * is not delivered here — and sends just three. Keeping the mirror this small is the
 * point: this app is a hand-portable stand-in, not a full client.
 *
 * The other mirrors (cloud `contract.py`, device `Contracts/*.cs`, chat + board
 * `contract.ts`) carry the full protocol and move in one pass with the canonical file.
 */

// ---------------------------------------------------------------------------
// handshake / pairing
// ---------------------------------------------------------------------------

export interface Hello {
  type: "hello";
  role: "ui";
  /** v4.1: which UI surface this is. This client is the input (Bixby) surface. */
  surface: "input";
  device_id?: string;
}

export interface HelloAck {
  type: "hello_ack";
  role: "ui" | "device";
  session_id: string;
  /** The session this socket is bound to; "" while still unbound. */
  device_id?: string;
}

export interface DeviceInfo {
  device_id: string;
  device_name: string;
  online: boolean;
}

/** Sent to an unbound UI (point-to-point, outside the input fork) so it can pick. */
export interface Devices {
  type: "devices";
  devices: DeviceInfo[];
}

/** Binds this UI socket to a device — the picker's answer. */
export interface SelectDevice {
  type: "select_device";
  device_id: string;
}

// ---------------------------------------------------------------------------
// goal submission (the ASR stand-in)
// ---------------------------------------------------------------------------

export interface UserGoal {
  type: "user_goal";
  text: string;
  /** UI-minted id, echoed back in `goal_accepted` so a submission can be tracked. */
  client_ref?: string;
}

/** Ties a submission to its cloud-assigned goal_id. */
export interface GoalAccepted {
  type: "goal_accepted";
  goal_id: string;
  client_ref?: string | null;
}

// ---------------------------------------------------------------------------
// notice (cloud → ui) — the terminal, non-plan message Bixby "speaks"
// ---------------------------------------------------------------------------

export interface Notice {
  type: "notice";
  goal_id: string;
  /** "out_of_scope" (declined by the interpreter) or "declined" (cancelled gate). */
  kind: "out_of_scope" | "declined" | "updating_goals";
  message: string;
}

// ---------------------------------------------------------------------------
// chat_ui_open / chat_ui_close (v4.1) — the create-phase bracket.
// On the input surface these drive the webview: open mounts it, close (matching
// goal_id) unmounts it. The device never sees either frame.
// ---------------------------------------------------------------------------

export interface ChatUiOpen {
  type: "chat_ui_open";
  goal_id: string;
  /** What the user said, verbatim (v7.4). Optional — a pre-v7.4 cloud omits it. */
  goal_text?: string;
}

export interface ChatUiClose {
  type: "chat_ui_close";
  goal_id: string;
}

// ---------------------------------------------------------------------------
// message unions
// ---------------------------------------------------------------------------

/** The ONLY frames the cloud delivers to an input surface (plus point-to-point
 *  `hello_ack`/`devices`). Anything else is forked away server-side. */
export type UiInboundMessage =
  | HelloAck
  | Devices
  | GoalAccepted
  | ChatUiOpen
  | ChatUiClose
  | Notice;

export type UiOutboundMessage = Hello | SelectDevice | UserGoal;
