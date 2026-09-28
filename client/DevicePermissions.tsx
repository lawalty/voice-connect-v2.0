import { useEffect, useRef, useState } from 'react';
import { Camera, Check, Clipboard, Mic, ShieldCheck } from 'lucide-react';
import Dialog from './Dialog';
import { permissionAvailability, permissionFailure, permissionKinds, queryDevicePermission, requestDevicePermission, type AccessResult, type DevicePermission } from './device-permissions';
import './device-permissions.css';

const descriptions = {
  microphone: { title: 'Microphone', purpose: 'Required for voice', detail: 'Speak to NorthPointe. Text chat works without it.', Icon: Mic },
  camera: { title: 'Camera', purpose: 'Optional · photos', detail: 'Take a photo to review and share.', Icon: Camera },
  clipboard: { title: 'Clipboard', purpose: 'Optional · paste', detail: 'Share copied text or images when you choose.', Icon: Clipboard },
};
const labels = { granted: 'Approved', denied: 'Blocked', prompt: 'Not granted yet', unknown: 'Tap to check', unavailable: 'Unavailable', insecure: 'HTTPS required', checked: 'Allowed this time', error: 'Needs attention' };
const initialAccess = (): Record<DevicePermission, AccessResult> => ({ microphone: { state: 'unknown' }, camera: { state: 'unknown' }, clipboard: { state: 'unknown' } });

export default function DevicePermissions({ onClose }: { onClose(): void }) {
  const [access, setAccess] = useState(initialAccess);
  const [pending, setPending] = useState<DevicePermission | null>(null);
  const active = useRef<DevicePermission | null>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const refresh = useRef(() => {});
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    mounted.current = true;
    let alive = true, refreshVersion = 0;
    const subscriptions = new Map<DevicePermission, () => void>();
    const update = (kind: DevicePermission, result: AccessResult) => {
      if (alive && active.current !== kind) setAccess(previous => ({ ...previous, [kind]: result }));
    };
    const check = () => {
      const version = ++refreshVersion;
      for (const kind of permissionKinds) {
        const unavailable = permissionAvailability(kind);
        if (unavailable) { update(kind, unavailable); continue; }
        void queryDevicePermission(kind).then(status => {
          if (!alive || version !== refreshVersion) return;
          subscriptions.get(kind)?.();
          subscriptions.delete(kind);
          if (!status) { update(kind, { state: 'unknown' }); return; }
          const changed = () => update(kind, { state: status.state });
          changed();
          status.addEventListener('change', changed);
          subscriptions.set(kind, () => status.removeEventListener('change', changed));
        });
      }
    };
    const visible = () => { if (document.visibilityState === 'visible') check(); };
    refresh.current = check;
    check();
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', visible);
    return () => {
      alive = false; mounted.current = false; generation.current++;
      clearTimeout(timer.current);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', visible);
      subscriptions.forEach(remove => remove());
    };
  }, []);

  async function request(kind: DevicePermission) {
    if (active.current) return;
    const unavailable = permissionAvailability(kind);
    if (unavailable) { setAccess(previous => ({ ...previous, [kind]: unavailable })); return; }
    const attempt = ++generation.current;
    const current = () => mounted.current && generation.current === attempt;
    active.current = kind; setPending(kind);
    // A browser prompt may remain unanswered forever. Let the user leave the panel;
    // late media results still stop their tracks in requestDevicePermission.
    timer.current = setTimeout(() => {
      if (!current()) return;
      generation.current++; active.current = null; setPending(null);
      setAccess(previous => ({ ...previous, [kind]: { state: 'error', detail: 'Chrome has not finished the request. Dismiss any open permission prompt before trying again, or check site settings below.' } }));
    }, 20_000);
    try {
      await requestDevicePermission(kind);
      if (!current()) return;
      // A successful operation alone does not prove a persistent permission grant.
      const status = await queryDevicePermission(kind);
      if (!current()) return;
      setAccess(previous => ({ ...previous, [kind]: {
        state: status?.state === 'granted' ? 'granted' : 'checked',
        detail: kind === 'clipboard' ? 'Read check complete. Clipboard contents were discarded; nothing was sent or changed.' : 'Device check complete. Access was released immediately; nothing was recorded or sent.',
      } }));
    } catch (error) {
      if (current()) setAccess(previous => ({ ...previous, [kind]: permissionFailure(kind, error) }));
    } finally {
      if (current()) { clearTimeout(timer.current); active.current = null; setPending(null); }
    }
  }

  return <Dialog title="Access request" onClose={onClose}>
    <div className="permission-intro"><ShieldCheck size={22} aria-hidden="true" /><p>Set up access for this browser. Tap each permission you want to use, then respond to Chrome.</p></div>
    <div className="permission-list">
      {permissionKinds.map(kind => {
        const { title, purpose, detail, Icon } = descriptions[kind];
        const result = access[kind];
        const allowed = result.state === 'granted' || result.state === 'checked';
        const unavailable = result.state === 'insecure' || result.state === 'unavailable';
        return <section key={kind} className="permission-card" aria-labelledby={`permission-${kind}`}>
          <div className="permission-heading"><Icon size={21} aria-hidden="true" /><div><h3 id={`permission-${kind}`}>{title}</h3><span>{purpose}</span></div></div>
          <p className="permission-description">{detail}</p>
          <div className="permission-action"><span className={`permission-status ${allowed ? 'permission-allowed' : ''}`} role="status">{allowed && <Check size={14} aria-hidden="true" />}{pending === kind ? 'Waiting for Chrome…' : labels[result.state]}</span><button className="button secondary small" disabled={Boolean(pending) || unavailable} onClick={() => void request(kind)}>{pending === kind ? 'Requesting…' : `${allowed ? 'Check' : result.state === 'error' || result.state === 'denied' ? 'Retry' : 'Allow'} ${title.toLowerCase()}`}</button></div>
          {result.detail && <p className="permission-detail" role="status">{result.detail}</p>}
        </section>;
      })}
    </div>
    <p className="permission-footnote">Approvals stay checked while Chrome allows access, including when you reopen VC. Temporary grants may expire; Chrome controls how long they last. Checks briefly open and release the microphone or camera, or read and discard the clipboard. Nothing is saved or sent to NorthPointe.</p>
    <details className="permission-recovery"><summary>Blocked or no prompt? Fix Chrome on Android</summary><ol>
      <li>In Chrome, tap the site controls icon beside VC’s address → Permissions. Allow Microphone or Camera. If Clipboard is listed, allow it too. You can also find VC under Chrome → Settings → Site settings → All sites.</li>
      <li>In Android Settings → Apps → Chrome → Permissions, allow Microphone and Camera. Check that Android’s microphone and camera privacy controls are on. Menu names vary by phone.</li>
      <li>Return to VC and tap Refresh status, then retry the permission. If clipboard access still fails, touch and hold in the message field and choose Paste.</li>
    </ol><p>VC can request access, but cannot override a block or change Chrome or Android settings. To revoke access, use Chrome’s site permissions.</p></details>
    <div className="dialog-actions permission-footer"><button className="text-button" disabled={Boolean(pending)} onClick={() => refresh.current()}>Refresh status</button><button className="button primary" onClick={onClose}>Done</button></div>
  </Dialog>;
}
