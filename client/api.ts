let csrfToken = '';
export function setCsrf(token?: string) { csrfToken = token || ''; }
export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  if (options.method && !['GET', 'HEAD'].includes(options.method)) headers.set('X-CSRF-Token', csrfToken);
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin', cache: 'no-store' });
  const data = response.status === 204 ? undefined : await response.json().catch(() => ({}));
  if (response.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event('vc-auth-expired'));
  if (!response.ok) throw new ApiError(data?.message || data?.error || `Request failed (${response.status}).`, response.status);
  return data as T;
}
