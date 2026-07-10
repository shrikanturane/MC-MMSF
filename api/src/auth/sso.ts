export interface SsoProfile {
  email: string;
  name: string;
}

export type SsoProvider = 'google' | 'microsoft';

/** Which SSO providers have credentials configured via env. */
export function ssoConfigured(): { google: boolean; microsoft: boolean } {
  return { google: !!process.env.GOOGLE_CLIENT_ID, microsoft: !!process.env.MS_CLIENT_ID };
}

/** Public base URL of the app (the HTTPS origin behind nginx). */
export function ssoBaseUrl(): string {
  return (process.env.SSO_BASE_URL || process.env.WEB_ORIGIN?.split(',')[0] || 'https://localhost').trim().replace(/\/+$/, '');
}

export function redirectUri(provider: SsoProvider): string {
  return `${ssoBaseUrl()}/api/auth/sso/${provider}/callback`;
}

export function authorizeUrl(provider: SsoProvider, state: string): string {
  if (provider === 'google') {
    const p = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || '',
      redirect_uri: redirectUri('google'),
      response_type: 'code',
      scope: 'openid email profile',
      state,
      access_type: 'online',
      prompt: 'select_account',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
  }
  const tenant = process.env.MS_TENANT || 'common';
  const p = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID || '',
    redirect_uri: redirectUri('microsoft'),
    response_type: 'code',
    scope: 'openid email profile User.Read',
    state,
    response_mode: 'query',
  });
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${p.toString()}`;
}

async function postForm(url: string, body: Record<string, string>): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) throw new Error(`token exchange ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.json();
}

async function getJson(url: string, token: string): Promise<any> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`profile fetch ${res.status}`);
  return res.json();
}

/** Exchange the OAuth code for tokens and return the user's email + name. */
export async function exchangeAndProfile(provider: SsoProvider, code: string): Promise<SsoProfile> {
  if (provider === 'google') {
    const tok = await postForm('https://oauth2.googleapis.com/token', {
      code,
      client_id: process.env.GOOGLE_CLIENT_ID || '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
      redirect_uri: redirectUri('google'),
      grant_type: 'authorization_code',
    });
    const ui = await getJson('https://openidconnect.googleapis.com/v1/userinfo', tok.access_token);
    return { email: String(ui.email || '').toLowerCase(), name: ui.name || ui.email || '' };
  }
  const tenant = process.env.MS_TENANT || 'common';
  const tok = await postForm(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    code,
    client_id: process.env.MS_CLIENT_ID || '',
    client_secret: process.env.MS_CLIENT_SECRET || '',
    redirect_uri: redirectUri('microsoft'),
    grant_type: 'authorization_code',
    scope: 'openid email profile User.Read',
  });
  const me = await getJson('https://graph.microsoft.com/v1.0/me', tok.access_token);
  return { email: String(me.mail || me.userPrincipalName || '').toLowerCase(), name: me.displayName || me.mail || '' };
}
