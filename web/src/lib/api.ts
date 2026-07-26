export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api';

export const TOKEN_KEY = 'mcmf_token';

function token(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

/** The stored bearer token, for the one place that can't send a header: the WebSocket handshake, where
 *  it is passed in the socket's FIRST message body (never the URL — a token in a query string leaks). */
export function authToken(): string | null {
  return token();
}

/** ws(s):// URL for the remote-support media relay viewer socket. API_BASE already ends in /api. */
export function mediaViewerWsUrl(sessionId: string): string {
  return `${API_BASE.replace(/^http/, 'ws')}/remote/media/viewer?session=${encodeURIComponent(sessionId)}`;
}

function authHeaders(base: Record<string, string> = {}): Record<string, string> {
  const t = token();
  return t ? { ...base, Authorization: `Bearer ${t}` } : base;
}

/** On an expired/invalid session, drop the token and bounce to the login gate. */
function handle401(res: Response, path: string) {
  if (res.status !== 401 || typeof window === 'undefined') return;
  if (path.startsWith('/auth/login')) return; // bad creds, handled by the form
  if (window.localStorage.getItem(TOKEN_KEY)) {
    window.localStorage.removeItem(TOKEN_KEY);
    window.location.reload();
  }
}

/**
 * Fetch a binary API resource (image/video) as an object URL.
 *
 * `<img src>` and `<a href>` cannot carry the Authorization header, so any guarded binary endpoint —
 * the remote-support frame and recording, for instance — 401s when referenced directly. Fetching it
 * with the header and wrapping the blob keeps the token out of the URL (never put credentials in a
 * query string) while still giving the DOM something it can render or download.
 *
 * The caller owns the returned URL and MUST revokeObjectURL it, or a 10 fps viewer leaks steadily.
 */
/**
 * Authed fetch returning the raw Blob. Preferred over apiBlobUrl for anything fetched repeatedly:
 * an object URL has a lifecycle the caller has to manage, and managing it at video frame rates is how
 * the remote viewer ended up revoking the URL it was currently displaying.
 */
export async function apiBlob(path: string): Promise<Blob> {
  const res = await fetch(`${API_BASE}${path}`, { cache: 'no-store', headers: authHeaders() });
  if (!res.ok) {
    handle401(res, path);
    throw new Error(`GET ${path} failed: ${res.status}`);
  }
  return res.blob();
}

export async function apiBlobUrl(path: string): Promise<string> {
  const res = await fetch(`${API_BASE}${path}`, { cache: 'no-store', headers: authHeaders() });
  if (!res.ok) {
    handle401(res, path);
    throw new Error(`GET ${path} failed: ${res.status}`);
  }
  return URL.createObjectURL(await res.blob());
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { cache: 'no-store', headers: authHeaders() });
  if (!res.ok) {
    handle401(res, path);
    throw new Error(`GET ${path} failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    handle401(res, path);
    throw new Error(await readError(res));
  }
  return res.json() as Promise<T>;
}

async function readError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return (body?.message || body?.detail || JSON.stringify(body)) as string;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    handle401(res, path);
    throw new Error(await readError(res));
  }
  return res.json() as Promise<T>;
}

export async function apiDelete<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) {
    handle401(res, path);
    throw new Error(await readError(res));
  }
  return res.json() as Promise<T>;
}

/** Fetch a file endpoint with auth and trigger a browser download. */
export async function apiDownload(path: string, fallbackName = 'download'): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, { headers: authHeaders() });
  if (!res.ok) {
    handle401(res, path);
    throw new Error(await readError(res));
  }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') || '';
  const name = cd.match(/filename="?([^"]+)"?/)?.[1] || fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    handle401(res, path);
    throw new Error(await readError(res));
  }
  return res.json() as Promise<T>;
}
