import { createSign } from 'node:crypto';
import type { ProviderCredentials } from './adapter';

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
  project_id?: string;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Parse the pasted service-account JSON key (tolerates surrounding whitespace). */
export function parseServiceAccountKey(raw?: string): ServiceAccountKey | null {
  if (!raw) return null;
  try {
    const key = JSON.parse(raw) as ServiceAccountKey;
    if (key.client_email && key.private_key) return key;
  } catch {
    /* not JSON */
  }
  return null;
}

/**
 * Resolve a GCP access token + project for a connection. Two modes:
 *  - Service Account JSON key (recommended, long-lived): mints a short-lived token via the
 *    signed-JWT OAuth grant (RS256, Node crypto — no SDK). The SA can hold Owner ("root-like")
 *    or just Viewer/Compute Viewer.
 *  - Raw OAuth access token (legacy/manual).
 */
export async function getGcpToken(creds: ProviderCredentials): Promise<{ token: string; project: string }> {
  const key = parseServiceAccountKey(creds.serviceAccountKey);
  const project = creds.project || key?.project_id || '';
  if (!project) throw new Error('GCP requires a project id (or a service-account key containing project_id)');

  if (key) {
    const tokenUri = key.token_uri || 'https://oauth2.googleapis.com/token';
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(
      JSON.stringify({
        iss: key.client_email,
        // Broad OAuth envelope accepted by all GCP APIs; the SA's IAM role (e.g. Viewer)
        // still restricts actual access to read-only. The narrower read-only scope is
        // rejected by some APIs as "insufficient authentication scopes".
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        aud: tokenUri,
        iat: now,
        exp: now + 3600,
      }),
    );
    const signingInput = `${header}.${claims}`;
    const signature = createSign('RSA-SHA256').update(signingInput).sign(key.private_key);
    const assertion = `${signingInput}.${b64url(signature)}`;

    const res = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    if (!res.ok) {
      throw new Error(`token exchange ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const body = (await res.json()) as { access_token?: string; error_description?: string };
    if (!body.access_token) throw new Error(body.error_description || 'no access_token returned');
    return { token: body.access_token, project };
  }

  if (creds.accessToken) return { token: creds.accessToken, project };

  throw new Error('GCP requires a Service Account JSON key (recommended) or an OAuth access token');
}
