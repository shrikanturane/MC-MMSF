export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api';

export const TOKEN_KEY = 'mcmf_token';

function token(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
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
