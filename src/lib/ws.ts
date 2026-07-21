/**
 * WebSocket client for the GoalFlow cloud hub (CONTRACT v4.1).
 *
 * This is the DEV SURROGATE for the native Tizen Bixby entry point. It declares
 * `surface: "input"` in its `hello`, so the cloud FORKS delivery and sends it only the
 * five input-surface frames (`hello_ack`, `devices`, `goal_accepted`, `chat_ui_open`,
 * `chat_ui_close`, `notice`) — never the board/agent firehose a native client would
 * only parse and drop.
 *
 * INVARIANT: this client talks ONLY to the cloud, never to the device. All traffic is
 * hub-relayed.
 *
 * The connection is a MODULE-LEVEL SINGLETON — copied deliberately from board-ui's
 * `ws.ts` rather than reinvented. That pattern is the scar tissue of a real WS storm:
 * StrictMode's double-mount, HMR, or a second consumer would each otherwise open a
 * competing socket. `close()` detaches callbacks but leaves the shared socket open, so
 * an immediate remount reuses it instead of churning connect/disconnect.
 */

import type { UiInboundMessage, UiOutboundMessage } from "../types/contract";

export type ConnectionState = "connecting" | "open" | "closed";

type Subscriber = {
  onMessage: (message: UiInboundMessage) => void;
  onState: (state: ConnectionState) => void;
};

/**
 * Frames this surface acts on. An unlisted frame is dropped silently — so THIS LIST IS
 * A SILENT DROPPER, and a contract addition that misses it fails at runtime looking
 * like nothing happened. The input surface is server-side forked, so in practice only
 * these six ever arrive; the allowlist is belt-and-suspenders.
 */
const INBOUND_TYPES = new Set([
  "hello_ack",
  "devices",
  "goal_accepted",
  "chat_ui_open",
  "chat_ui_close",
  "notice",
]);

/** Remembered device pick. Deliberately NOT sent in `hello` — see App. */
const REMEMBERED_DEVICE_KEY = "goalflow.device_id";

export function getDeviceId(search = window.location.search): string {
  return new URLSearchParams(search).get("device") ?? "";
}

export function getRememberedDeviceId(): string {
  try {
    return window.localStorage.getItem(REMEMBERED_DEVICE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function rememberDeviceId(deviceId: string): void {
  try {
    window.localStorage.setItem(REMEMBERED_DEVICE_KEY, deviceId);
  } catch {
    /* private mode: pairing just won't persist */
  }
}

function resolveUrl(): string {
  const configured = import.meta.env.VITE_WS_URL;
  if (configured) return configured;
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.hostname}:8000/ws`;
}

const subscribers = new Set<Subscriber>();
let sharedSocket: WebSocket | null = null;
let currentState: ConnectionState = "closed";
let reconnectTimer: number | null = null;
let pendingDeviceId = "";

function setState(state: ConnectionState): void {
  currentState = state;
  subscribers.forEach((s) => s.onState(state));
}

function openSharedSocket(): void {
  if (sharedSocket && (sharedSocket.readyState === WebSocket.OPEN || sharedSocket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  setState("connecting");
  const socket = new WebSocket(resolveUrl());
  sharedSocket = socket;

  socket.onopen = () => {
    setState("open");
    const hello: UiOutboundMessage = pendingDeviceId
      ? { type: "hello", role: "ui", surface: "input", device_id: pendingDeviceId }
      : { type: "hello", role: "ui", surface: "input" };
    socket.send(JSON.stringify(hello));
  };

  socket.onmessage = (event) => {
    let frame: UiInboundMessage;
    try {
      frame = JSON.parse(event.data as string) as UiInboundMessage;
    } catch {
      console.warn("[bixby] dropped an unparseable frame");
      return;
    }
    if (!INBOUND_TYPES.has(frame.type)) {
      // The input surface is forked server-side, so this should never fire; if it
      // does, the cloud sent an input frame this mirror hasn't heard of.
      console.warn("[bixby] dropped an unexpected frame:", frame.type);
      return;
    }
    subscribers.forEach((s) => s.onMessage(frame));
  };

  socket.onclose = (event) => {
    setState("closed");
    sharedSocket = null;
    // 1012: the cloud evicted this socket for a newer one with the same identity.
    // Reconnecting would start an eviction storm between two tabs.
    if (event.code === 1012) return;
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(openSharedSocket, 1500);
  };

  socket.onerror = () => {
    /* onclose does the work; this only silences the unhandled-error noise */
  };
}

export interface GoalFlowSocket {
  connect: (deviceId?: string) => void;
  send: (message: UiOutboundMessage) => void;
  close: () => void;
  readonly state: ConnectionState;
}

export function createGoalFlowSocket(options: Subscriber): GoalFlowSocket {
  const subscriber: Subscriber = options;
  return {
    connect(deviceId = "") {
      pendingDeviceId = deviceId;
      subscribers.add(subscriber);
      subscriber.onState(currentState);
      openSharedSocket();
    },
    send(message) {
      if (sharedSocket?.readyState === WebSocket.OPEN) {
        sharedSocket.send(JSON.stringify(message));
      } else {
        console.warn("[bixby] send while closed:", message.type);
      }
    },
    close() {
      subscribers.delete(subscriber);
      // Deliberately does NOT close the shared socket — see the header.
    },
    get state() {
      return currentState;
    },
  };
}
