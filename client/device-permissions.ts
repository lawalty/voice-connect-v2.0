export const permissionKinds = ['microphone', 'camera', 'clipboard'] as const;
export type DevicePermission = typeof permissionKinds[number];
export type AccessState = PermissionState | 'unknown' | 'unavailable' | 'insecure' | 'checked' | 'error';
export type AccessResult = { state: AccessState; detail?: string };

export function permissionAvailability(kind: DevicePermission): AccessResult | null {
  if (!window.isSecureContext) return { state: 'insecure', detail: 'Open VC over HTTPS to request access.' };
  const supported = kind === 'clipboard'
    ? Boolean(navigator.clipboard?.read || navigator.clipboard?.readText)
    : Boolean(navigator.mediaDevices?.getUserMedia);
  return supported ? null : {
    state: 'unavailable',
    detail: kind === 'clipboard' ? 'Use touch and hold → Paste in the message field instead.' : 'This browser does not expose this device. Open VC directly in Chrome.',
  };
}

export async function queryDevicePermission(kind: DevicePermission): Promise<PermissionStatus | null> {
  try {
    if (!navigator.permissions?.query) return null;
    return await navigator.permissions.query({ name: (kind === 'clipboard' ? 'clipboard-read' : kind) as PermissionName });
  } catch { return null; }
}

// Invoke directly in the click handler, before any awaited work. Never call on mount.
// Do not return clipboard contents or connect a media stream to recording/sending.
export async function requestDevicePermission(kind: DevicePermission): Promise<void> {
  if (kind === 'clipboard') {
    if (navigator.clipboard?.read) await navigator.clipboard.read();
    else if (navigator.clipboard?.readText) await navigator.clipboard.readText();
    else throw new DOMException('Clipboard unavailable', 'NotSupportedError');
    return;
  }
  const stream = await navigator.mediaDevices.getUserMedia(kind === 'microphone' ? { audio: true, video: false } : { video: true, audio: false });
  // Also runs when a browser prompt resolves after this panel has been closed.
  stream.getTracks().forEach(track => track.stop());
}

export function permissionFailure(kind: DevicePermission, error: unknown): AccessResult {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return {
    state: 'error', detail: kind === 'clipboard'
      ? 'Clipboard access was not allowed. Try again from this button, check site permissions, or touch and hold → Paste in the message field.'
      : 'Access was not allowed. Check Chrome site permissions and Android app permissions below, then try again.',
  };
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return { state: 'error', detail: `No ${kind} was found. Connect or enable one, then try again.` };
  if (name === 'NotReadableError' || name === 'TrackStartError') return {
    state: 'error', detail: kind === 'clipboard' ? 'Chrome could not read the clipboard. Copy something and try again, or paste in the message field.' : 'The device could not open. Close other apps using it and check Android privacy controls, then try again.',
  };
  return { state: 'error', detail: 'The check did not complete. Try again, or check the recovery steps below.' };
}
