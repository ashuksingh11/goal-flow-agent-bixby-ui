import type { DeviceInfo } from "../types/contract";

/**
 * Choose which device agent this surrogate is bound to.
 *
 * Same shape as the board/chat UIs' pickers, and deliberately so — one home, several
 * surfaces, one mental model of "which fridge am I looking at". A UI must be BOUND
 * before it can send, so on a multi-device hub the surrogate can't submit a goal until
 * this is answered. With a single agent online the cloud auto-pairs and this never
 * appears; `?device=<id>` skips it too.
 */
export function DevicePicker({
  devices,
  currentDeviceId,
  onSelect,
  onCancel,
}: {
  devices: DeviceInfo[];
  currentDeviceId?: string | null;
  onSelect: (deviceId: string) => void;
  onCancel?: () => void;
}) {
  return (
    <section className="picker" aria-live="polite">
      <div className="picker-title">
        {devices.length === 0
          ? "Waiting for a device agent…"
          : currentDeviceId
            ? "Switch device"
            : "Which device is yours?"}
      </div>

      {devices.length === 0 ? (
        <div className="empty">Start the device agent and it will appear here.</div>
      ) : (
        devices.map((device) => (
          <button key={device.device_id} className="picker-item" onClick={() => onSelect(device.device_id)}>
            <div className="picker-item-name">
              {device.device_name || device.device_id}
              {device.device_id === currentDeviceId && <span className="picker-tag"> · current</span>}
              {!device.online && <span className="picker-tag"> · offline</span>}
            </div>
            <div className="picker-item-id">{device.device_id}</div>
          </button>
        ))
      )}

      {onCancel && (
        <button className="picker-cancel" onClick={onCancel}>
          Cancel
        </button>
      )}
    </section>
  );
}
