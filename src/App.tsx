import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DevicePicker } from "./components/DevicePicker";
import { MicButton } from "./components/MicButton";
import {
  createGoalFlowSocket,
  getDeviceId,
  getRememberedDeviceId,
  rememberDeviceId,
  type ConnectionState,
  type GoalFlowSocket,
} from "./lib/ws";
import type { DeviceInfo, UiInboundMessage } from "./types/contract";

/**
 * Bixby dev surrogate — the ASR + webview-control shell a native Tizen app would be.
 *
 * It does exactly (and ONLY) what native Bixby does in dev:
 *  - a text box + Send stands in for on-device ASR → sends `user_goal` with a minted
 *    `client_ref`, declaring `surface:"input"` at the handshake. v12 puts a real
 *    microphone next to that box (Sarvam STT, see lib/stt.ts) — the transcript lands in
 *    the box and the user still taps Send, so the wire behaviour is unchanged;
 *  - a device picker binds the socket (an unbound UI can't send);
 *  - a notice banner speaks the cloud's terminal `notice` ("Bixby speaks:");
 *  - a webview surrogate — an <iframe> at the chat UI — MOUNTED on `chat_ui_open` and
 *    UNMOUNTED on `chat_ui_close` when the goal_id matches the open one. Mount/unmount
 *    (not hide/show) so the surrogate exercises the webview RELOAD path; the chat UI's
 *    own reset-on-open covers the reuse path a real Bixby may take.
 *
 * It renders NONE of the planning/board content — the cloud forks the input surface, so
 * this client only ever sees its lifecycle frames.
 */

function resolveChatUiUrl(deviceId: string): string {
  const base = import.meta.env.VITE_CHAT_UI_URL ?? "http://localhost:5173";
  try {
    const url = new URL(base);
    if (deviceId) url.searchParams.set("device", deviceId);
    return url.toString();
  } catch {
    // Malformed override: still make a best effort so the demo shows something.
    const sep = base.includes("?") ? "&" : "?";
    return deviceId ? `${base}${sep}device=${encodeURIComponent(deviceId)}` : base;
  }
}

interface NoticeState {
  kind: string;
  message: string;
}

interface LogEntry {
  clientRef: string;
  text: string;
  goalId?: string;
}

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: "connecting…",
  open: "connected",
  closed: "offline",
};

export function App() {
  const [connection, setConnection] = useState<ConnectionState>("closed");
  const [boundDeviceId, setBoundDeviceId] = useState<string | null>(null);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [deviceOffline, setDeviceOffline] = useState(false);
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [openGoalId, setOpenGoalId] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  // v12 — a CLIENT-side failure (mic, proxy, Sarvam). Deliberately not routed through
  // the `notice` banner: that banner is the cloud speaking, and borrowing it for a local
  // problem would put words in the agent's mouth.
  const [sttError, setSttError] = useState<string | null>(null);

  const socketRef = useRef<GoalFlowSocket | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const clientRefSeq = useRef(0);
  // Mirror of boundDeviceId read INSIDE handleMessage. handleMessage is memoized once
  // (deps: []), so it would otherwise close over the initial `null` forever. The `devices`
  // handler needs the live bound id to tell "offline" from "unbound", and it must run its
  // send/rememberDeviceId side effects exactly once — so it reads this ref rather than a
  // functional-updater (which StrictMode double-invokes) to stay side-effect-safe.
  const boundDeviceIdRef = useRef<string | null>(null);

  const bound = Boolean(boundDeviceId);

  useEffect(() => {
    boundDeviceIdRef.current = boundDeviceId;
  }, [boundDeviceId]);

  const handleMessage = useCallback((frame: UiInboundMessage) => {
    switch (frame.type) {
      case "hello_ack": {
        const id = frame.device_id ?? "";
        if (id) {
          // The cloud binds whatever id we sent — INCLUDING an offline one. So we bind
          // optimistically and close the picker, but do NOT treat this as proof the
          // device is online: the next `devices` frame is authoritative and re-opens the
          // picker / heals if the id turns out to be absent (offline).
          boundDeviceIdRef.current = id;
          setBoundDeviceId(id);
          rememberDeviceId(id);
          setShowPicker(false);
          setDeviceOffline(false);
        } else {
          // Still unbound — await the `devices` list / picker.
          boundDeviceIdRef.current = null;
          setBoundDeviceId(null);
        }
        break;
      }
      case "devices": {
        setDevices(frame.devices);
        const boundId = boundDeviceIdRef.current;
        if (!boundId) {
          // Unbound — surface the picker so the user can choose (current behavior).
          setShowPicker(true);
          break;
        }
        // The cloud's `devices` list carries ONLY online devices (offline ones are
        // OMITTED, never online:false). So a bound id missing from the list == our paired
        // device agent is offline, and the cloud has silently bound us to an empty session.
        const stillOnline = frame.devices.some((d) => d.device_id === boundId);
        if (stillOnline) {
          setDeviceOffline(false);
          break;
        }
        if (frame.devices.length === 1) {
          // Exactly one device online → auto-rebind to it. After the resulting hello_ack,
          // boundDeviceId is that online id → present in the next `devices` list → this
          // clears, so there is no rebind loop.
          const target = frame.devices[0].device_id;
          socketRef.current?.send({ type: "select_device", device_id: target });
          rememberDeviceId(target);
          setDeviceOffline(false);
        } else {
          // 0 or 2+ online devices → no single auto-heal target. Mark bound-but-offline
          // (this both opens the picker over the composer and drives the reconnecting
          // line, which is only shown for the empty case — see the status area).
          setShowPicker(true);
          setDeviceOffline(true);
        }
        break;
      }
      case "goal_accepted": {
        setLog((entries) =>
          entries.map((entry) =>
            entry.clientRef === frame.client_ref ? { ...entry, goalId: frame.goal_id } : entry,
          ),
        );
        break;
      }
      case "chat_ui_open": {
        // Open (or retarget) the webview to this goal. A notice and a webview are
        // mutually exclusive — an accepted goal clears any prior spoken notice.
        setNotice(null);
        setOpenGoalId(frame.goal_id);
        break;
      }
      case "chat_ui_close": {
        // Close ONLY if it matches the goal currently open (Bixby's rule). A close for
        // a superseded/older goal is ignored.
        setOpenGoalId((current) => (current === frame.goal_id ? null : current));
        break;
      }
      case "notice": {
        setNotice({ kind: frame.kind, message: frame.message });
        break;
      }
    }
  }, []);

  // Bring up the singleton socket once. StrictMode double-mounts in dev; the shared
  // socket in ws.ts absorbs that, and close() only detaches this subscriber.
  useEffect(() => {
    const socket = createGoalFlowSocket({
      onMessage: handleMessage,
      onState: setConnection,
    });
    socketRef.current = socket;
    const preferred = getDeviceId() || getRememberedDeviceId();
    socket.connect(preferred);
    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [handleMessage]);

  const submitGoal = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || !bound) return;
    clientRefSeq.current += 1;
    const clientRef = `bixby-${Date.now()}-${clientRefSeq.current}`;
    socketRef.current?.send({ type: "user_goal", text: trimmed, client_ref: clientRef });
    setLog((entries) => [{ clientRef, text: trimmed }, ...entries].slice(0, 6));
    setNotice(null);
    setSttError(null);
    setText("");
  }, [text, bound]);

  const onTranscript = useCallback((transcript: string) => {
    // REPLACES the box rather than appending. A second dictation after a bad one should
    // not have to be hand-deleted first, and dictating on top of typed text is not a
    // thing anyone means to do at a fridge.
    setSttError(null);
    setText(transcript);
    const input = inputRef.current;
    if (input) {
      input.focus();
      input.setSelectionRange(transcript.length, transcript.length);
    }
  }, []);

  const selectDevice = useCallback((deviceId: string) => {
    socketRef.current?.send({ type: "select_device", device_id: deviceId });
    rememberDeviceId(deviceId);
    setShowPicker(false);
    setDeviceOffline(false);
  }, []);

  const chatUiSrc = useMemo(
    () => resolveChatUiUrl(boundDeviceId ?? ""),
    [boundDeviceId],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitGoal();
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◎</span>
          <span className="brand-name">Bixby</span>
          <span className="brand-sub">dev surrogate · input surface</span>
        </div>
        <div className={`status ${connection}`}>
          <span className="dot" />
          {CONNECTION_LABEL[connection]}
          {bound ? (
            <span className="status-device"> · {boundDeviceId}</span>
          ) : (
            <span className="status-device status-unbound"> · unbound</span>
          )}
          {deviceOffline && devices.length === 0 && (
            <span className="status-offline" aria-live="polite">
              {" "}
              · Paired device offline — reconnecting…
            </span>
          )}
        </div>
      </header>

      <main className="stage">
        {showPicker && (!bound || deviceOffline) ? (
          <DevicePicker
            devices={devices}
            currentDeviceId={boundDeviceId}
            onSelect={selectDevice}
          />
        ) : (
          <section className="composer">
            <label className="composer-label" htmlFor="utterance">
              Speak to Bixby <span className="composer-hint">(mic, or type)</span>
            </label>
            <textarea
              id="utterance"
              ref={inputRef}
              className="composer-input"
              placeholder={bound ? "e.g. Plan our meals for the week" : "Bind a device to start…"}
              value={text}
              disabled={!bound}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={onKeyDown}
              rows={3}
            />
            <div className="composer-actions">
              {bound && devices.length > 1 && (
                <button className="link-btn" onClick={() => setShowPicker(true)}>
                  Switch device
                </button>
              )}
              <MicButton
                disabled={!bound}
                onStart={() => setSttError(null)}
                onTranscript={onTranscript}
                onError={setSttError}
              />
              <button className="send-btn" onClick={submitGoal} disabled={!bound || !text.trim()}>
                Send
              </button>
            </div>
            {sttError && (
              <div className="stt-error" role="status">
                {sttError}
              </div>
            )}
          </section>
        )}

        {notice && (
          <section className={`notice notice-${notice.kind}`} aria-live="polite">
            <div className="notice-label">Bixby speaks:</div>
            <div className="notice-message">{notice.message}</div>
          </section>
        )}

        {openGoalId ? (
          <section className="webview">
            <div className="webview-bar">
              <span className="webview-dot" />
              Chat webview · goal {openGoalId.slice(0, 8)}…
            </div>
            {/*
              MOUNTED on chat_ui_open, UNMOUNTED on the matching chat_ui_close. The key
              on goal_id forces a fresh iframe (reload) per create phase, so this
              surrogate exercises the webview reload path.
            */}
            {/*
              v11 — `allow="autoplay"` DELEGATES the autoplay permission to the frame.

              This is not optional and it is not a nicety. The chat UI is served from a
              different port, so it is CROSS-ORIGIN to this page, and a cross-origin
              iframe has autoplay disabled by Permissions Policy no matter how many
              gestures the user has made: `audio.play()` inside it rejects with
              NotAllowedError before user activation is even consulted. Without this
              attribute the cloud's `speech` frame arrives, the chat UI tries to speak,
              is refused, and falls back to its "Hear this" tap — which works, but hides
              a permission problem behind a button.

              THIS SURROGATE IS THE BEST CASE, NOT THE CONTRACT. On a real Hub, native
              Bixby creates the WebView and we cannot set anything on it; the chat UI
              must therefore still degrade gracefully, and does. See
              goal-flow-agent-chat-ui/src/lib/speech.ts.
            */}
            <iframe
              key={openGoalId}
              className="webview-frame"
              src={chatUiSrc}
              title="GoalFlow chat webview"
              allow="autoplay"
            />
          </section>
        ) : (
          <section className="idle">
            <div className="idle-glyph">◎</div>
            <div className="idle-text">
              No active create phase. Send a goal — when the cloud starts planning, the chat
              webview opens here.
            </div>
          </section>
        )}

        {log.length > 0 && (
          <section className="log">
            <div className="log-title">Sent goals</div>
            <ul>
              {log.map((entry) => (
                <li key={entry.clientRef}>
                  <span className="log-text">{entry.text}</span>
                  <span className="log-meta">
                    {entry.goalId ? `accepted · ${entry.goalId.slice(0, 8)}…` : "sending…"}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  );
}
